import { expect, test } from '@playwright/test';
import {
  uniqueLabel,
  startApproval,
  submitAndCapture,
  clearApprovalInvocations,
  createAndSelectApprovalAgent,
  expectApprovalInvocationCount,
  expectCompletedApprovalToolOutput,
} from '../tool-approvals.helpers';
import { cleanupAgent } from '../agents.helpers';
import { withMongo } from '../db';

test.describe('Tool approval provenance', () => {
  test('an edited approval resumes and its saved reply marks the edit as user-submitted @scenario:an-edited-approval-keeps-its-user-submitted-provenance', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const editedValue = `edited-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue, editedValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);
      const conversationId = new URL(page.url()).pathname.split('/').pop();

      await card.getByRole('button', { name: 'Edit' }).click();
      await card
        .getByRole('textbox', { name: 'Edit' })
        .fill(JSON.stringify({ value: editedValue }));
      const { response } = await submitAndCapture(
        page,
        card.getByRole('button', { name: 'Submit' }),
      );
      expect((await response.json()).status).toBe('resuming');

      await expectCompletedApprovalToolOutput(
        page,
        toolCallId,
        `E2E approval probe executed: ${editedValue}`,
      );
      await expectApprovalInvocationCount(editedValue, 1);

      await expect
        .poll(
          () =>
            withMongo(async (db) => {
              const reply = await db
                .collection('messages')
                .findOne({ conversationId, isCreatedByUser: false }, { sort: { createdAt: -1 } });
              return reply?.userSubmittedPaths ?? [];
            }),
          { timeout: 30000 },
        )
        .toEqual(
          expect.arrayContaining([expect.stringMatching(/^\/content\/\d+\/tool_call\/args$/)]),
        );
    } finally {
      clearApprovalInvocations(originalValue, editedValue);
      await cleanupAgent(page, agentId);
    }
  });
});
