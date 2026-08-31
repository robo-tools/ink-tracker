import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatementFileWithAliases } from '../apps/hyatt/statement-import.js';

const account = { id: 'hyatt-1234', name: 'World of Hyatt', last4: '1234' };
const file = { name: '20240131-statements-1234-.pdf', arrayBuffer: async () => new ArrayBuffer(4) };

function mismatch() {
  const error = new Error('This statement does not match the selected card ending.');
  error.code = 'statement-card-ending-mismatch';
  error.statementLast4 = '9876';
  error.selectedLast4 = '1234';
  return error;
}

test('statement import asks once before accepting a prior card ending and retries the same file', async () => {
  let parseCount = 0;
  let confirmation = null;
  const parsed = await parseStatementFileWithAliases(file, account, '20240131', {
    aliases: [],
    parsePdf: async (_bytes, parseAccount) => {
      parseCount += 1;
      if (!parseAccount.statementLast4Aliases.includes('9876')) throw mismatch();
      return { statementDate: '2024-01-31' };
    },
    confirmAlias: (details) => { confirmation = details; return true; }
  });

  assert.equal(parseCount, 2);
  assert.deepEqual(confirmation, {
    filename: file.name,
    priorLast4: '9876',
    selectedLast4: '1234'
  });
  assert.equal(parsed.addedAlias, '9876');
  assert.deepEqual(parsed.aliases, ['9876']);
});

test('statement import waits for an asynchronous in-app confirmation', async () => {
  let answer;
  const parsedPromise = parseStatementFileWithAliases(file, account, '20240131', {
    aliases: [],
    parsePdf: async (_bytes, parseAccount) => {
      if (!parseAccount.statementLast4Aliases.includes('9876')) throw mismatch();
      return { statementDate: '2024-01-31' };
    },
    confirmAlias: () => new Promise((resolve) => { answer = resolve; })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof answer, 'function');
  answer(true);
  assert.equal((await parsedPromise).addedAlias, '9876');
});

test('statement import keeps a mismatched ending rejected when confirmation is declined', async () => {
  await assert.rejects(parseStatementFileWithAliases(file, account, '20240131', {
    parsePdf: async () => { throw mismatch(); },
    confirmAlias: () => false
  }), /does not match the selected card ending/);
});

test('a confirmed prior ending remains scoped to the selected account', async () => {
  const otherAccount = { id: 'hyatt-2222', name: 'World of Hyatt', last4: '2222' };
  await assert.rejects(parseStatementFileWithAliases(file, otherAccount, '20240131', {
    aliases: ['9876'],
    parsePdf: async (_bytes, parseAccount) => {
      assert.deepEqual(parseAccount.statementLast4Aliases, ['9876']);
      const error = mismatch();
      error.statementLast4 = '1234';
      error.selectedLast4 = '2222';
      throw error;
    },
    confirmAlias: () => false
  }), /does not match the selected card ending/);
});
