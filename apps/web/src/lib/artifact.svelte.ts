// One interactive artifact surface for the whole app. Transcript renderers leave
// a durable launcher in chat; the report itself opens in the right-side sheet.

export interface ArtifactDocument {
  name: string;
  src?: string;
  html?: string;
  code?: string;
  sessionId?: string;
}

export const artifact = $state<{ document: ArtifactDocument | null }>({ document: null });

export function openArtifact(document: ArtifactDocument): void {
  artifact.document = document;
}

export function closeArtifact(): void {
  artifact.document = null;
}
