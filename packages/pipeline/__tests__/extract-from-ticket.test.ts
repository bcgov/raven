import { describe, it, expect, vi } from "vitest";
import { extractFromTicket } from "../src/steps/extract-from-ticket.js";

vi.mock("../src/ai-client.js", () => ({
  askAI: vi.fn().mockResolvedValue('{"summary":"s","rootCause":"r","severity":"medium","suggestedTitle":"t"}'),
}));

function mockJira(description: string, comments: string[]) {
  return {
    getIssue: vi.fn().mockResolvedValue({
      key: "ARTS-220",
      fields: {
        summary: "Expand character limit for Representative field",
        description,
        labels: [],
        priority: { name: "Medium" },
      },
    }),
    getComments: vi.fn().mockResolvedValue({ comments: comments.map((body) => ({ body })) }),
  };
}

describe("extractFromTicket ticketText", () => {
  it("returns the full summary + description + comments text", async () => {
    const jira = mockJira("The Representative field truncates at 40 chars.", ["Seen again in TEST on the Agreement Parties screen."]);
    const { ticketText } = await extractFromTicket("ARTS-220", jira as never);
    expect(ticketText).toContain("Expand character limit");
    expect(ticketText).toContain("truncates at 40 chars");
    expect(ticketText).toContain("Agreement Parties screen");
  });
});
