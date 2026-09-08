// One interactive artifact surface for the whole app. Transcript renderers leave
// a durable launcher in chat; the report itself opens in the right-side sheet.

export interface ArtifactDocument {
  name: string;
  src?: string;
  html?: string;
  code?: string;
  sessionId?: string;
}

export const artifact = $state<{ document: ArtifactDocument | null; revision: number }>({ document: null, revision: 0 });

export function openArtifact(document: ArtifactDocument): void {
  artifact.document = document;
  artifact.revision++;
}

export function closeArtifact(): void {
  if (!artifact.document) return;
  artifact.document = null;
  artifact.revision++;
}
