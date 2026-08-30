import { normalizeLast4 } from '../../packages/chase-core/lib/normalize.js';
import { parseChaseStatementPdf } from '../../packages/chase-core/app/chase-statements.js';

export function normalizeStatementLast4Aliases(values, selectedLast4 = '') {
  const current = normalizeLast4(selectedLast4);
  return [...new Set((values ?? []).map(normalizeLast4).filter((last4) => last4 && last4 !== current))];
}

export async function parseStatementFileWithAliases(file, account, fallbackStatementDate = '', options = {}) {
  const parsePdf = options.parsePdf ?? parseChaseStatementPdf;
  const confirmAlias = options.confirmAlias ?? (() => false);
  const aliases = normalizeStatementLast4Aliases(options.aliases, account?.last4);

  async function parse() {
    return parsePdf(
      await file.arrayBuffer(),
      { ...account, statementLast4Aliases: aliases },
      fallbackStatementDate
    );
  }

  try {
    return { result: await parse(), aliases, addedAlias: '' };
  } catch (error) {
    const priorLast4 = normalizeLast4(error?.statementLast4);
    if (error?.code !== 'statement-card-ending-mismatch' || !priorLast4 || aliases.includes(priorLast4)) throw error;
    const accepted = await confirmAlias({
      filename: String(file?.name ?? ''),
      priorLast4,
      selectedLast4: normalizeLast4(account?.last4)
    });
    if (!accepted) throw error;
    aliases.push(priorLast4);
    return { result: await parse(), aliases, addedAlias: priorLast4 };
  }
}
