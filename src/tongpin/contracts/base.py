from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


@dataclass
class APIError(Exception):
    code: str
    message: str
    status: int = 400
    fields: dict | None = None
    retry_after_ms: int | None = None

    def payload(self, request_id):
        error = {"code": self.code, "message": self.message}
        if self.fields:
            error["fieldErrors"] = self.fields
        if self.retry_after_ms:
            error["retryAfterMs"] = self.retry_after_ms
        return {"error": error, "requestId": request_id}


class HealthResponse(BaseModel):
    status: str
    version: str
    features: dict[str, bool]
