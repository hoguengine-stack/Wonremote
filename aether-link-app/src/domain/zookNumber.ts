export function normalizeZookNumber(value: string): string {
  const number = value.trim();
  if (number && !/^[0-9]{8}$/.test(number)) throw new Error("ZOOK 고유번호는 숫자 8자리로 입력해 주세요.");
  return number;
}
