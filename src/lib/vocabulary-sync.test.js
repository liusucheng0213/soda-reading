import { describe, expect, it } from "vitest";
import {
  vocabularyFromRow,
  vocabularyRecord,
  vocabularyWriteAttempts,
} from "@soda-reading/api-client";

describe("vocabulary cloud record", () => {
  it("stores the common sense and referent, then falls back when those columns are missing", () => {
    const record = vocabularyRecord("user-1", {
      contentId: "piece",
      contentHash: "piece",
      word: "bank",
      translation: "河岸",
      commonTranslation: "银行",
      sentence: "We sat on the river bank.",
    });
    expect(record.common_translation).toBe("银行");
    expect(record.referent).toBe(false);
    expect(record.sentence_key).toBe("1684fa3b");
    const attempts = vocabularyWriteAttempts(record);
    expect(attempts[1].record.common_translation).toBeUndefined();
    expect(attempts[1].record.sentence_key).toBe(record.sentence_key);
    expect(attempts[2].record.sentence_key).toBeUndefined();
    expect(vocabularyFromRow({
      id: "remote",
      content_id: "piece",
      content_hash: "piece",
      word: "it",
      translation: "文中指代河岸",
      common_translation: "",
      referent: true,
      sentence: "It flooded.",
    })).toMatchObject({
      translation: "文中指代河岸",
      referent: true,
    });
  });

  it("marks a referent gloss even when the flag was not stored on the item", () => {
    const record = vocabularyRecord("user-1", {
      contentId: "piece",
      word: "it",
      translation: "文中指代河岸",
      sentence: "It flooded.",
    });
    expect(record.referent).toBe(true);
    expect(record.common_translation).toBe("");
  });
});
