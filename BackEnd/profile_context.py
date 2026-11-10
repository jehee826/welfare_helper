"""저장 정보의 명시적 제공 동의와 최종 생성 전용 조건 계약."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from BackEnd.core.privacy import sensitive_input


REGIONS = {"서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시",
           "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도", "전북특별자치도", "전라남도",
           "경상북도", "경상남도", "제주특별자치도"}


class ProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    age: int | None = Field(default=None, ge=0, le=120, strict=True)
    income: Literal["under50", "under100", "under150", "over150", "unknown"] = "unknown"
    household: Literal["single", "couple", "withChildren", "singleParent", "grandparent", "other"] | None = None
    region: str | None = Field(default=None, max_length=20)
    disability: bool | None = Field(default=None, strict=True)

    @field_validator("region")
    @classmethod
    def validate_region_privacy(cls, value):
        if value is not None and sensitive_input(value):
            raise PydanticCustomError("sensitive_input", "개인정보를 제외하고 질문해 주세요.")
        return value


class ProfileContext(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    consent_revision: int = Field(ge=0, le=9007199254740991)
    profile_revision: int = Field(ge=0, le=9007199254740991)
    profile: ProfileIn

    @model_validator(mode="after")
    def explicit_consent(self):
        if not self.enabled or self.profile.region is not None and self.profile.region not in REGIONS:
            raise ValueError("현재 저장 정보에 대한 명시적 동의와 허용 지역이 필요합니다.")
        return self
