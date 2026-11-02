import type { Household, UserProfile } from "../api/types";

export const HOUSEHOLD_OPTIONS: { value: Household; label: string }[] = [
  { value: "single", label: "혼자 살아요" },
  { value: "couple", label: "부부" },
  { value: "withChildren", label: "자녀가 있어요" },
  { value: "singleParent", label: "한부모 가정" },
  { value: "grandparent", label: "조부모와 손자녀" },
  { value: "other", label: "기타" },
];

export function describeProfile(profile: UserProfile): string {
  const household = HOUSEHOLD_OPTIONS.find((o) => o.value === profile.household)?.label ?? "";
  const parts = [`${profile.age}세`, household, profile.region];
  if (profile.disability) parts.push("장애 있음");
  return parts.filter(Boolean).join(" · ");
}
