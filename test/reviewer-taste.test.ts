import { expect, it } from "vitest";
import { chooseReviewerTaste } from "../src/reviewer-taste";
it("同题同轮的三个人格标签稳定去重，换题或换轮可改变", () => {
	const first = chooseReviewerTaste("synthetic-1", 1);
	expect(new Set(first).size).toBe(3);
	expect(chooseReviewerTaste("synthetic-1", 1)).toEqual(first);
	const variants = Array.from({ length: 12 }, (_, index) =>
		JSON.stringify(chooseReviewerTaste("synthetic-" + index, 1)),
	);
	expect(new Set(variants).size).toBeGreaterThan(3);
	expect(chooseReviewerTaste("synthetic-1", 2)).not.toEqual(first);
});
