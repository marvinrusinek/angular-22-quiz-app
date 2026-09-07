package com.quizbackend.interview;

public enum SessionStatus {
    ACTIVE, SUBMITTED, EXPIRED;

    public String wireValue() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }

    public static SessionStatus fromWireValue(String value) {
        for (SessionStatus status : values()) {
            if (status.wireValue().equals(value)) {
                return status;
            }
        }
        throw new IllegalArgumentException("unknown session status \"" + value + "\"");
    }
}
