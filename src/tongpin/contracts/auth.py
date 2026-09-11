from pydantic import Field

from tongpin.contracts.base import InputModel


class CaptchaInput(InputModel):
    captchaId: str = Field(min_length=1, max_length=128)
    captchaAnswer: str = Field(min_length=1, max_length=32)


class RegisterInput(CaptchaInput):
    username: str = Field(max_length=64)
    nickname: str = Field(max_length=128)
    password: str = Field(max_length=128)
    termsVersion: str = Field(max_length=100)
    acceptTerms: bool
    siteInvite: str = Field(default="", max_length=256)


class LoginInput(CaptchaInput):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(max_length=128)
    remember: bool = False
    secondFactor: str = Field(default="", max_length=100)
    admin: bool = False


class RecoverInput(CaptchaInput):
    username: str = Field(max_length=64)
    recoveryCode: str = Field(max_length=100)
    password: str = Field(max_length=128)
    secondFactor: str = Field(default="", max_length=100)


class ReauthInput(InputModel):
    password: str = Field(max_length=128)
    action: str = Field(min_length=1, max_length=160)
    secondFactor: str = Field(default="", max_length=100)


class SensitiveInput(InputModel):
    reauthToken: str = Field(min_length=1, max_length=200)


class PasswordInput(SensitiveInput):
    password: str = Field(max_length=128)


class ProfileInput(InputModel):
    nickname: str = Field(max_length=128)
    bio: str = Field(default="", max_length=800)


class PreferencesInput(InputModel):
    invisible: bool | None = None
    readReceipts: bool | None = None
    doNotDisturb: bool | None = None
