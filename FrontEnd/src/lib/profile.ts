import type { Household, IncomeBracket, UserProfile } from "../api/types";

export const INCOME_OPTIONS: { value: IncomeBracket; label: string }[] = [
  { value: "under50", label: "기준중위소득 50% 이하" },
  { value: "under100", label: "기준중위소득 50~100%" },
  { value: "under150", label: "기준중위소득 100~150%" },
  { value: "over150", label: "기준중위소득 150% 초과" },
  { value: "unknown", label: "잘 모르겠어요" },
];

export const HOUSEHOLD_OPTIONS: { value: Household; label: string }[] = [
  { value: "single", label: "혼자 살아요" },
  { value: "couple", label: "부부" },
  { value: "withChildren", label: "자녀가 있어요" },
  { value: "singleParent", label: "한부모 가정" },
  { value: "grandparent", label: "조부모와 손자녀" },
  { value: "other", label: "기타" },
];

export const REGIONS = [
  "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시",
  "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도",
  "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도",
];

export function describeProfile(profile: UserProfile): string {
  const household = HOUSEHOLD_OPTIONS.find((o) => o.value === profile.household)?.label ?? "";
  const parts = [`${profile.age}세`, household, profile.region];
  if (profile.disability) parts.push("장애 있음");
  return parts.filter(Boolean).join(" · ");
}
