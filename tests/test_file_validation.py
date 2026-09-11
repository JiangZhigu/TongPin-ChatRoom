from __future__ import annotations

import io
import os
import socket
import struct
import subprocess
import threading
import time
import zipfile
import zlib
from contextlib import contextmanager

import pytest
from PIL import Image

from tongpin.contracts.base import APIError
from tongpin.infra.file_validation import filename, image_versions, validate_document
from tongpin.infra.paths import DataPaths
from tongpin.infra.scanner import ClamdScanner


def rejected(code, action):
    with pytest.raises(APIError) as caught:
        action()
    assert caught.value.code == code


@pytest.mark.parametrize("name,mime,code", [
    ("../unsafe.png", "image/png", "INVALID_FILENAME"),
    ("file.txt:stream", "", "INVALID_FILENAME"),
    ("misleading\u202eexe.png", "", "INVALID_FILENAME"),
    ("bad\0.txt", "", "INVALID_FILENAME"),
    ("payload.svg", "image/svg+xml", "FILE_TYPE_UNSUPPORTED"),
    ("old.doc", "application/msword", "FILE_TYPE_UNSUPPORTED"),
    ("wrong.png", "application/pdf", "FILE_TYPE_MISMATCH"),
])
def test_rejects_path_control_unsupported_and_inconsistent_mime(name, mime, code):
    rejected(code, lambda: filename(name, mime))


def test_filename_mime_aliases_and_utf8_document_are_canonical(tmp_path):
    assert filename("中文.JPG", "image/pjpeg") == ("jpg", "image", "image/jpeg")
    assert filename("未提供MIME.txt", "") == ("txt", "file", "text/plain")
    assert filename("日常.csv", "application/vnd.ms-excel") == ("csv", "file", "text/csv")
    path = tmp_path / "document.bin"
    for content, ext in [("普通中文\r\n一\t二\n", "txt"), ("# 普通标题", "md"), ("a,b\n1,2", "csv"), ('{"title":"真实JSON"}', "json")]:
        path.write_text(content, encoding="utf-8")
        validate_document(path, ext)
    for content, ext, code in [(b"\xff\xfe\x80", "txt", "FILE_ENCODING"), (b"<svg onload='x'>", "txt", "FILE_TYPE_MISMATCH"), (b"MZbinary", "md", "FILE_TYPE_MISMATCH"), (b"#! /bin/sh", "txt", "FILE_TYPE_MISMATCH"), (b"valid\0bad", "csv", "FILE_TYPE_MISMATCH"), (b"{broken}", "json", "FILE_TYPE_MISMATCH"), (b"%PDF-1.7\nno ending", "pdf", "FILE_TYPE_MISMATCH")]:
        path.write_bytes(content)
        rejected(code, lambda extension=ext: validate_document(path, extension))
    path.write_bytes(b"%PDF-1.7\n% controlled minimal envelope only\n%%EOF")
    validate_document(path, "pdf")


def test_private_paths_reject_actual_symlink_or_windows_junction(tmp_path):
    paths = DataPaths(tmp_path / "data")
    paths.prepare()
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "kept.txt"
    sentinel.write_text("outside original", encoding="utf-8")
    link = paths.uploads / "redirect"
    if os.name == "nt":
        environment = os.environ.copy()
        environment.update(TONGPIN_TEST_LINK=str(link), TONGPIN_TEST_TARGET=str(outside))
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:TONGPIN_TEST_LINK -Target $env:TONGPIN_TEST_TARGET | Out-Null"], env=environment, capture_output=True, timeout=10, check=False, creationflags=subprocess.CREATE_NO_WINDOW)
        assert result.returncode == 0 and link.is_junction()
    else:
        link.symlink_to(outside, target_is_directory=True)
        assert link.is_symlink()
    try:
        with pytest.raises(ValueError, match="symbolic links or junctions"):
            paths.private_file(link, "kept.txt")
        with pytest.raises(ValueError, match="symbolic links or junctions"):
            DataPaths(link)
        with pytest.raises(ValueError):
            paths.private_file(paths.uploads, "../outside")
        assert sentinel.read_text(encoding="utf-8") == "outside original"
    finally:
        if os.name == "nt":
            link.rmdir()  # Remove only the junction itself, never traverse its target.
        else:
            link.unlink()


def zip_bytes(entries, compression=zipfile.ZIP_STORED):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=compression) as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return stream.getvalue()


def test_bounded_zip_directory_paths_compression_encryption_and_ooxml(tmp_path):
    path = tmp_path / "container.bin"
    path.write_bytes(zip_bytes([("[Content_Types].xml", "<Types/>"), ("word/document.xml", "<document/>")]))
    validate_document(path, "docx")
    rejected("FILE_TYPE_MISMATCH", lambda: validate_document(path, "xlsx"))
    path.write_bytes(zip_bytes([("../escape.txt", "x")]))
    rejected("ARCHIVE_PATH", lambda: validate_document(path, "zip"))
    path.write_bytes(zip_bytes([("a.txt", b"0" * 1000000)], zipfile.ZIP_DEFLATED))
    rejected("ARCHIVE_LIMIT", lambda: validate_document(path, "zip"))
    path.write_bytes(zip_bytes([(f"{i}.txt", b"") for i in range(2001)]))
    rejected("ARCHIVE_LIMIT", lambda: validate_document(path, "zip"))
    encrypted = bytearray(zip_bytes([("a.txt", b"x")]))
    struct.pack_into("<H", encrypted, encrypted.index(b"PK\x01\x02") + 8, 1)
    path.write_bytes(encrypted)
    rejected("ARCHIVE_LIMIT", lambda: validate_document(path, "zip"))
    directory_bomb = bytearray(zip_bytes([("a.txt", b"x")]))
    struct.pack_into("<I", directory_bomb, directory_bomb.rindex(b"PK\x05\x06") + 12, 3 * 1024**2)
    path.write_bytes(directory_bomb)
    rejected("ARCHIVE_LIMIT", lambda: validate_document(path, "zip"))
    path.write_bytes(zip_bytes([("a.txt", b"x")]) + b"unexpected trailer")
    rejected("ARCHIVE_LIMIT", lambda: validate_document(path, "zip"))


def seven_header(next_header=b"\0", length=None, offset=0):
    tail = struct.pack("<QQI", offset, len(next_header) if length is None else length, zlib.crc32(next_header))
    return b"7z\xbc\xaf\x27\x1c\0\4" + struct.pack("<I", zlib.crc32(tail)) + tail + next_header


def test_7z_checks_exact_fixed_header_next_range_and_both_crcs(tmp_path):
    path = tmp_path / "seven.bin"
    path.write_bytes(seven_header())
    validate_document(path, "7z")
    for content, code in [(seven_header(offset=2**63), "ARCHIVE_LIMIT"), (seven_header(length=3 * 1024**2), "ARCHIVE_LIMIT"), (seven_header()[:-1] + b"x", "FILE_TYPE_MISMATCH"), (b"not 7z", "FILE_TYPE_MISMATCH")]:
        path.write_bytes(content)
        rejected(code, lambda: validate_document(path, "7z"))
    corrupt_crc = bytearray(seven_header())
    corrupt_crc[8] ^= 1
    path.write_bytes(corrupt_crc)
    rejected("ARCHIVE_LIMIT", lambda: validate_document(path, "7z"))


def test_images_decode_every_frame_bound_dimensions_and_strip_exif(tmp_path):
    path = tmp_path / "image.bin"
    exif = Image.Exif()
    exif[274] = 6
    exif[270] = "private synthetic metadata"
    Image.new("RGB", (60, 20), "blue").save(path, "JPEG", exif=exif)
    versions = image_versions(path, "jpg")
    assert (versions["width"], versions["height"], versions["frame_count"]) == (20, 60, 1)
    with Image.open(io.BytesIO(versions["preview"])) as preview:
        assert preview.format == "WEBP" and preview.size == (20, 60)
        assert not preview.getexif()
    rejected("IMAGE_INVALID", lambda: image_versions(path, "png"))
    Image.new("RGB", (8193, 1), "red").save(path, "PNG")
    rejected("IMAGE_LIMIT", lambda: image_versions(path, "png"))
    frames = [Image.new("RGB", (12, 12), color) for color in ("red", "green", "blue")]
    frames[0].save(path, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    versions = image_versions(path, "gif")
    assert versions["frame_count"] == 3
    with Image.open(io.BytesIO(versions["preview"])) as preview:
        assert getattr(preview, "n_frames", 1) == 1
    original = path.read_bytes()
    path.write_bytes(original[:-12])
    rejected("IMAGE_INVALID", lambda: image_versions(path, "gif"))
    frames = [Image.new("RGB", (2, 2), (i, 255 - i, i)) for i in range(201)]
    frames[0].save(path, "GIF", save_all=True, append_images=frames[1:], optimize=False, duration=10)
    rejected("IMAGE_LIMIT", lambda: image_versions(path, "gif"))


@contextmanager
def controlled_scanner(reply=b"stream: OK\0", delay=0):
    observed = {"command": b"", "body": bytearray(), "errors": []}
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(2)

    def serve():
        try:
            with listener.accept()[0] as connection:
                connection.settimeout(2)

                def exact(size):
                    result = bytearray()
                    while len(result) < size:
                        chunk = connection.recv(size - len(result))
                        if not chunk:
                            raise EOFError()
                        result.extend(chunk)
                    return bytes(result)

                while not observed["command"].endswith(b"\0") and len(observed["command"]) < 32:
                    observed["command"] += exact(1)
                if observed["command"] == b"zINSTREAM\0":
                    while size := struct.unpack("!I", exact(4))[0]:
                        assert size <= 65536 and len(observed["body"]) + size <= 1024**2
                        observed["body"].extend(exact(size))
                time.sleep(delay)
                connection.sendall(reply[:3])
                connection.sendall(reply[3:])
        except (EOFError, BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except (OSError, AssertionError, struct.error) as caught:
            observed["errors"].append(type(caught).__name__)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield ClamdScanner("127.0.0.1", listener.getsockname()[1], 0.2), observed
    finally:
        thread.join(3)
        listener.close()
        assert not thread.is_alive() and not observed["errors"]


def test_actual_tcp_instream_framing_and_ping_health_are_distinct(tmp_path):
    path = tmp_path / "scanned.bin"
    data = b"controlled local protocol bytes" * 5000
    path.write_bytes(data)
    with controlled_scanner() as (scanner, observed):
        assert scanner.scan(path, len(data)).status == "clean"
    assert observed["command"] == b"zINSTREAM\0" and observed["body"] == data
    with controlled_scanner(b"PONG\0") as (scanner, observed):
        assert scanner.health() == {"status": "reachable", "code": None}
    assert observed["command"] == b"zPING\0" and not observed["body"]
    with controlled_scanner() as (scanner, _):
        assert scanner.scan(path, 10).status == "unknown"
    assert ClamdScanner().scan(path, len(data)).code == "SCANNER_DISABLED"
    with pytest.raises(ValueError):
        ClamdScanner("example.com", 3310)


@pytest.mark.parametrize("reply,state", [
    (b"stream: Synthetic-Test-Signature FOUND\0", "infected"),
    (b"stream: size limit ERROR\0", "unknown"),
    (b"stream: OK", "unknown"),
    (b"stream: OK\0stream: OK\0", "unknown"),
    (b"x" * 600 + b"\0", "unknown"),
    (b"PONG\0", "unknown"),
])
def test_scanner_does_not_promote_errors_truncation_extra_records_to_clean(tmp_path, reply, state):
    path = tmp_path / "scanned.bin"
    path.write_bytes(b"bounded")
    with controlled_scanner(reply) as (scanner, _):
        assert scanner.scan(path, 7).status == state


def test_scanner_deadline_produces_unknown_not_clean(tmp_path):
    path = tmp_path / "scanned.bin"
    path.write_bytes(b"bounded")
    with controlled_scanner(delay=0.3) as (scanner, _):
        started = time.monotonic()
        assert scanner.scan(path, 7).status == "unknown"
        assert time.monotonic() - started < 0.6
