import argparse
import json
import re
import sqlite3
import time
from pathlib import Path


BOT_STEP_TYPE = 15
REQUIRED_QUARANTINE_LABELS = ["직접 실행/확인:", "원문 결과:", "수정 여부:"]
FORBIDDEN_QUARANTINE_TERMS = [
    "완료",
    "완벽",
    "100%",
    "입증",
    "문제 없음",
    "테스트",
    "benchmark",
    "벤치마크",
]


def normalize_payload(payload: bytes) -> str:
    text = payload.decode("utf-8", errors="ignore")
    text = "".join(ch if ch.isprintable() or ch in "\n\r\t" else " " for ch in text)
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


def read_latest_bot_response(db_path: Path, after_idx: int) -> dict:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        row = con.execute(
            """
            select idx, step_payload
            from steps
            where idx > ? and step_type = ? and status = 3 and step_payload is not null
            order by idx desc
            limit 1
            """,
            (after_idx, BOT_STEP_TYPE),
        ).fetchone()
    finally:
        con.close()

    if not row:
        return {
            "found": False,
            "compliant": False,
            "idx": None,
            "text_excerpt": "",
            "violations": ["no bot response after requested index"],
        }

    idx, payload = row
    text = normalize_payload(payload)
    return {
      "found": True,
      "compliant": True,
      "idx": idx,
      "text_excerpt": text[:1200],
      "violations": [],
    }


def apply_strict_quarantine_policy(result: dict, must_contain: str | None = None) -> dict:
    if not result["found"]:
        result["compliant"] = False
        return result

    text = result["text_excerpt"]
    violations = []
    for label in REQUIRED_QUARANTINE_LABELS:
        if label not in text:
            violations.append(f"missing required quarantine label: {label}")
    for term in FORBIDDEN_QUARANTINE_TERMS:
        if term in text:
            violations.append(f"forbidden term: {term}")
    if must_contain and must_contain not in text:
        violations.append(f"missing expected text: {must_contain}")

    result["violations"] = violations
    result["compliant"] = len(violations) == 0
    return result


def wait_for_response(
    db_path: Path,
    after_idx: int,
    timeout_seconds: float,
    strict_quarantine: bool,
    must_contain: str | None,
) -> dict:
    deadline = time.monotonic() + max(timeout_seconds, 0)
    while True:
        result = read_latest_bot_response(db_path, after_idx)
        if result["found"]:
            if strict_quarantine:
                result = apply_strict_quarantine_policy(result, must_contain)
            return result
        if time.monotonic() >= deadline:
            return apply_strict_quarantine_policy(result, must_contain) if strict_quarantine else result
        time.sleep(2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--after-idx", type=int, required=True)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--strict-quarantine", action="store_true")
    parser.add_argument("--must-contain")
    args = parser.parse_args()

    result = wait_for_response(
        Path(args.db),
        args.after_idx,
        args.timeout,
        args.strict_quarantine,
        args.must_contain,
    )
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
