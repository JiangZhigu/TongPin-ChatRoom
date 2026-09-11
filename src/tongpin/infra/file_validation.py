from __future__ import annotations

import hashlib
import io
import json
import re
import struct
import unicodedata
import warnings
import zlib
from pathlib import PurePosixPath

from PIL import Image, ImageOps, UnidentifiedImageError

from tongpin.contracts.base import APIError

IMAGE_FORMATS = {"png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "webp": "WEBP", "gif": "GIF"}
MIMES = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif",
    "pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown", "csv": "text/csv", "json": "application/json",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip", "7z": "application/x-7z-compressed",
}
ALIASES = {
    "jpg": {"image/pjpeg"}, "jpeg": {"image/pjpeg"}, "md": {"text/plain", "text/x-markdown"},
    "csv": {"text/plain", "application/vnd.ms-excel"}, "json": {"text/plain", "text/json"},
    "zip": {"application/x-zip-compressed"},
    "docx": {"application/zip"}, "xlsx": {"application/zip"}, "pptx": {"application/zip"},
}


def invalid(code="FILE_TYPE_MISMATCH", message="文件名称、类型或内容不符合支持格式，请重新选择文件。"):
    raise APIError(code, message, 422)


def filename(name, mime):
    if (
        not name or name != name.strip() or len(name.encode("utf-8")) > 600
        or any(c in name for c in '/\\:') or name in {".", ".."}
        or any(unicodedata.category(c) in {"Cc", "Cs", "Cf"} for c in name)
        or name.endswith((".", " "))
    ):
        invalid("INVALID_FILENAME", "文件名不能包含路径、控制字符或首尾空白。")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in MIMES:
        invalid("FILE_TYPE_UNSUPPORTED", "此文件类型暂不支持，请选择允许的图片或文档。")
    value = mime.lower().strip()
    if value not in {"", "application/octet-stream", MIMES[ext]} | ALIASES.get(ext, set()):
        invalid()
    return ext, "image" if ext in IMAGE_FORMATS else "file", MIMES[ext]


def digest_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def validate_zip(path, ext):
    # Parse only bounded central-directory bytes, without materializing an
    # unbounded list of ZipInfo instances or extracting a single member.
    size = path.stat().st_size
    with path.open("rb") as stream:
        stream.seek(max(0, size - 65557))
        tail = stream.read(65557)
        offset = tail.rfind(b"PK\x05\x06")
        if offset < 0 or len(tail) - offset < 22:
            invalid()
        disk, start_disk, count_disk, count, directory_size, start, comment = struct.unpack_from("<HHHHIIH", tail, offset + 4)
        eocd = max(0, size - 65557) + offset
        if disk or start_disk or count_disk != count or count > 2000 or directory_size > 2 * 1024**2 or len(tail) - offset != 22 + comment or start + directory_size != eocd:
            invalid("ARCHIVE_LIMIT", "压缩包目录、条目数量或结构超出允许范围。")
        stream.seek(start)
        directory = stream.read(directory_size)
        cursor, total, names = 0, 0, set()
        for _ in range(count):
            if cursor + 46 > len(directory) or directory[cursor:cursor+4] != b"PK\x01\x02":
                invalid()
            flags, compressed, expanded = struct.unpack_from("<H10xII", directory, cursor + 8)
            name_size, extra_size, comment_size = struct.unpack_from("<HHH", directory, cursor + 28)
            local_offset = struct.unpack_from("<I", directory, cursor + 42)[0]
            end = cursor + 46 + name_size + extra_size + comment_size
            if flags & 1 or not name_size or name_size > 4096 or end > len(directory) or local_offset >= start:
                invalid("ARCHIVE_LIMIT", "压缩包包含加密、异常目录或不受支持的条目。")
            try:
                name = directory[cursor+46:cursor+46+name_size].decode("utf-8" if flags & 0x800 else "cp437").replace("\\", "/")
            except UnicodeError:
                invalid()
            if name.startswith("/") or ":" in name or "\0" in name or ".." in PurePosixPath(name).parts or name in names:
                invalid("ARCHIVE_PATH", "压缩包包含不允许的路径或重复条目。")
            if (not compressed and expanded) or expanded > max(1, compressed) * 100:
                invalid("ARCHIVE_LIMIT", "压缩包的声明展开比例超出限制。")
            total += expanded
            if total > 500 * 1024**2:
                invalid("ARCHIVE_LIMIT", "压缩包的声明展开总量超出限制。")
            names.add(name)
            cursor = end
        if cursor != len(directory):
            invalid()
    expected = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}
    if ext in expected and not {"[Content_Types].xml", expected[ext]} <= names:
        invalid()


def validate_7z(path):
    size = path.stat().st_size
    with path.open("rb") as stream:
        header = stream.read(32)
        if len(header) != 32 or header[:8] != b"7z\xbc\xaf\x27\x1c\0\4":
            invalid()
        crc, offset, length, next_crc = struct.unpack_from("<IQQI", header, 8)
        if zlib.crc32(header[12:]) != crc or length > 2 * 1024**2 or 32 + offset + length > size:
            invalid("ARCHIVE_LIMIT", "7Z头部范围、校验值或元数据大小不符合要求。")
        stream.seek(32 + offset)
        if zlib.crc32(stream.read(length)) != next_crc:
            invalid()


def validate_document(path, ext):
    with path.open("rb") as stream:
        header = stream.read(1024)
    if ext in {"zip", "docx", "xlsx", "pptx"}:
        if header[:4] not in {b"PK\x03\x04", b"PK\x05\x06"}:
            invalid()
        validate_zip(path, ext)
    elif ext == "7z":
        validate_7z(path)
    elif ext == "pdf":
        if not re.match(rb"%PDF-[12]\.\d", header):
            invalid()
        with path.open("rb") as stream:
            stream.seek(max(0, path.stat().st_size - 1024))
            if b"%%EOF" not in stream.read(1024):
                invalid()
    else:
        if header.startswith((b"MZ", b"\x7fELF", b"PK\x03\x04", b"\xca\xfe\xba\xbe", b"#!")):
            invalid()
        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeError:
            invalid("FILE_ENCODING", "纯文本文件须使用有效的UTF-8编码。")
        if any(unicodedata.category(c) in {"Cc", "Cs"} and c not in "\r\n\t" for c in text) or re.match(r"\s*<(?:!doctype\s+html|html|svg|script|\?php)\b", text, re.IGNORECASE):
            invalid()
        if ext == "json":
            try:
                json.loads(text)
            except (ValueError, RecursionError):
                invalid("FILE_TYPE_MISMATCH", "JSON文件内容不是有效的JSON。")


def image_versions(path, ext, avatar=False):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path, formats=[IMAGE_FORMATS[ext]]) as probe:
                if probe.format != IMAGE_FORMATS[ext]:
                    invalid()
                probe.verify()
            with Image.open(path, formats=[IMAGE_FORMATS[ext]]) as opened:
                frames, pixels, first = 0, 0, None
                for number in range(201):
                    try:
                        opened.seek(number)
                    except EOFError:
                        break
                    width, height = opened.size
                    pixels += width * height
                    if number >= 200 or max(width, height) > 8192 or width * height > 20_000_000 or pixels > 40_000_000:
                        invalid("IMAGE_LIMIT", "图片尺寸、帧数或解码总量超过限制。")
                    opened.load()
                    if first is None:
                        first = ImageOps.exif_transpose(opened.copy()).convert("RGBA")
                    frames += 1
                if first is None:
                    invalid()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise APIError("IMAGE_INVALID", "图片无法完成解码校验，请重新导出后上传。", 422) from error
    width, height = first.size
    preview = ImageOps.fit(first, (512, 512), method=Image.Resampling.LANCZOS) if avatar else first.copy()
    preview.thumbnail((2560, 2560), Image.Resampling.LANCZOS)
    encoded = io.BytesIO()
    preview.save(encoded, "WEBP", quality=82, method=4)
    if encoded.tell() > 2 * 1024**2:
        preview.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        encoded = io.BytesIO()
        preview.save(encoded, "WEBP", quality=78, method=4)
    if encoded.tell() > 2 * 1024**2:
        invalid("IMAGE_LIMIT", "图片预览仍超出处理预算，请降低尺寸后上传。")
    thumb = preview.copy()
    thumb.thumbnail((320, 320), Image.Resampling.LANCZOS)
    small = io.BytesIO()
    thumb.save(small, "WEBP", quality=78, method=4)
    return {"width": width, "height": height, "frame_count": frames, "preview": encoded.getvalue(), "thumbnail": small.getvalue()}
