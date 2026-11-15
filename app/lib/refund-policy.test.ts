import { describe, it, expect } from "vitest";
import {
  isInsideRefundWindow,
  refundWindowDaysLeft,
  REFUND_WINDOW_DAYS,
} from "./refund-policy";

describe("refund window", () => {
  const purchased = new Date(2026, 0, 1, 23, 0).toISOString();

  it("includes the whole of the last day, even for a late-night purchase", () => {
    const lastDay = new Date(2026, 0, 1 + REFUND_WINDOW_DAYS, 23, 59);
    expect(isInsideRefundWindow(purchased, lastDay)).toBe(true);
  });

  it("closes the day after the last day", () => {
    const after = new Date(2026, 0, 2 + REFUND_WINDOW_DAYS, 0, 1);
    expect(isInsideRefundWindow(purchased, after)).toBe(false);
  });

  it("counts whole days left, 0 on the last day, negative once closed", () => {
    expect(refundWindowDaysLeft(purchased, new Date(2026, 0, 1, 9))).toBe(14);
    expect(refundWindowDaysLeft(purchased, new Date(2026, 0, 15, 9))).toBe(0);
    expect(refundWindowDaysLeft(purchased, new Date(2026, 0, 17, 9))).toBe(-2);
  });
});
