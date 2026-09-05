package com.wonremote.agent;

import com.google.firebase.firestore.FirebaseFirestoreException;

final class FirebaseQuota {
    private FirebaseQuota() {}

    static boolean exhausted(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof FirebaseFirestoreException
                && ((FirebaseFirestoreException) cause).getCode() == FirebaseFirestoreException.Code.RESOURCE_EXHAUSTED) {
                return true;
            }
        }
        return false;
    }

    static long retryDelayMs(Throwable error) {
        return exhausted(error) ? 300_000 : 10_000;
    }

    static String registrationMessage(Throwable error) {
        if (exhausted(error)) {
            return "등록 보류 · 서버 사용량 한도를 초과했습니다. 앱 삭제나 재설치로 해결되지 않습니다. 관리자에게 문의하고 한도 복구 후 다시 등록하세요.";
        }
        return error == null ? "등록 실패" : "등록 실패 · " + error.getMessage();
    }
}
