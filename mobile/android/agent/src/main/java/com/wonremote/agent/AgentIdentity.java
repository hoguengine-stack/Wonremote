package com.wonremote.agent;

import java.util.Locale;

final class AgentIdentity {
    private AgentIdentity() {}

    static String normalizeBusinessDigits(String value) {
        String digits = value == null ? "" : value.replaceAll("\\D", "");
        if (digits.length() != 10) {
            throw new IllegalArgumentException("사업자등록번호는 숫자 10자리여야 합니다.");
        }
        return digits;
    }

    static String formatBusinessNumber(String value) {
        String digits = normalizeBusinessDigits(value);
        return digits.substring(0, 3) + "-" + digits.substring(3, 5) + "-" + digits.substring(5);
    }

    static String authEmail(String businessNumber) {
        return normalizeBusinessDigits(businessNumber) + "@agents.wonremote.app";
    }

    static String authPassword(String businessNumber, String password) {
        if (!"1234".equals(password)) {
            throw new IllegalArgumentException("비밀번호가 올바르지 않습니다.");
        }
        return "wonremote-" + normalizeBusinessDigits(businessNumber) + "-" + password;
    }

    static String deviceNumber(String installId) {
        String suffix = installId == null ? "" : installId.trim()
            .replaceFirst("(?i)^agent[-_]?", "")
            .replaceAll("[^a-zA-Z0-9-]", "")
            .toUpperCase(Locale.ROOT);
        if (suffix.length() > 16) {
            suffix = suffix.substring(0, 16);
        }
        if (suffix.isEmpty()) {
            throw new IllegalArgumentException("Agent 설치 식별자를 확인할 수 없습니다.");
        }
        return "AGENT-" + suffix;
    }

    static String deviceId(String businessNumber, String installId) {
        return formatBusinessNumber(businessNumber) + ":" + deviceNumber(installId);
    }
}
