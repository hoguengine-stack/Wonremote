import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("antigravity_response_reader.py")


class AntigravityResponseReaderTest(unittest.TestCase):
    def make_db(self, rows):
        tmp = tempfile.TemporaryDirectory()
        db_path = Path(tmp.name) / "conversation.db"
        con = sqlite3.connect(db_path)
        con.execute(
            "create table steps (idx integer primary key, step_type integer not null, status integer not null, step_payload blob)"
        )
        con.executemany(
            "insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)",
            [(idx, step_type, status, payload.encode("utf-8")) for idx, step_type, status, payload in rows],
        )
        con.commit()
        con.close()
        return tmp, db_path

    def run_reader(self, db_path, after_idx, must_contain=None):
        command = [
            sys.executable,
            str(SCRIPT),
            "--db",
            str(db_path),
            "--after-idx",
            str(after_idx),
            "--timeout",
            "0",
            "--strict-quarantine",
        ]
        if must_contain:
            command.extend(["--must-contain", must_contain])

        result = subprocess.run(
            command,
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_accepts_strict_three_line_quarantine_response(self):
        tmp, db_path = self.make_db(
            [
                (10, 101, 3, "system request"),
                (
                    11,
                    15,
                    3,
                    "직접 실행/확인: C:/repo/file.ts\n원문 결과: target line\n수정 여부: 수정 없음",
                ),
            ]
        )
        with tmp:
            data = self.run_reader(db_path, 10)

        self.assertTrue(data["found"])
        self.assertTrue(data["compliant"])
        self.assertEqual(data["idx"], 11)
        self.assertEqual(data["violations"], [])

    def test_rejects_three_line_response_without_expected_worker_output(self):
        tmp, db_path = self.make_db(
            [
                (30, 101, 3, "system request"),
                (
                    31,
                    15,
                    3,
                    "직접 실행/확인: C:/repo/file.ts\n원문 결과: unrelated line\n수정 여부: 수정 없음",
                ),
            ]
        )
        with tmp:
            data = self.run_reader(db_path, 30, must_contain="target line")

        self.assertTrue(data["found"])
        self.assertFalse(data["compliant"])
        self.assertIn("missing expected text: target line", data["violations"])

    def test_rejects_gemini_report_with_completion_and_test_counts(self):
        tmp, db_path = self.make_db(
            [
                (20, 101, 3, "system request"),
                (21, 15, 3, "검증 및 보완 조치가 완료되었습니다. 모든 단위 테스트(188개)가 통과했습니다."),
            ]
        )
        with tmp:
            data = self.run_reader(db_path, 20)

        self.assertTrue(data["found"])
        self.assertFalse(data["compliant"])
        self.assertIn("missing required quarantine label: 직접 실행/확인:", data["violations"])
        self.assertIn("forbidden term: 완료", data["violations"])
        self.assertIn("forbidden term: 테스트", data["violations"])


if __name__ == "__main__":
    unittest.main()
