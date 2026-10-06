import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkAnchorStrategy, MarkStatus, ReticleDir } from '@reticlehq/core';
import { noteKey, recordNotes, type NotesFile } from './notes-ledger.js';
import { ReviewStore } from './review-store.js';

const data = (note: string) => ({
  note,
  anchor: 'component:Submit@src/Checkout.tsx:42',
  strategy: MarkAnchorStrategy.COMPONENT,
  route: '/checkout',
});

const readNotes = (root: string): NotesFile =>
  JSON.parse(readFileSync(join(root, ReticleDir.NOTES_FILE), 'utf8')) as NotesFile;

describe('the notes ledger', () => {
  it('keeps a note on disk through its resolution, and across a new session', () => {
    const root = mkdtempSync(join(tmpdir(), 'reticle-notes-'));
    const first = new ReviewStore((marks) => recordNotes(root, marks));
    const mark = first.add(data('total is wrong'), 10);
    first.add(data('button misaligned'), 20);
    first.resolve(mark.id);

    // A reload starts a new session whose ids begin again: the file must not lose the old notes.
    const second = new ReviewStore((marks) => recordNotes(root, marks));
    second.add(data('footer overlaps'), 5);

    const { notes } = readNotes(root);
    expect(Object.keys(notes)).toHaveLength(3);
    expect(notes[noteKey(data('total is wrong'))]?.status).toBe(MarkStatus.RESOLVED);
    expect(notes[noteKey(data('footer overlaps'))]).toMatchObject({
      note: 'footer overlaps',
      status: MarkStatus.PENDING,
    });
    expect(JSON.stringify(notes)).not.toContain('"id"');
  });

  it('writes nothing when no project is known', () => {
    expect(() => recordNotes(undefined, [])).not.toThrow();
  });
});
