export interface Ticket {
  key: string;
  project: string;
  summary: string;
  description: string;
  issueType: string;
  labels: string[];
  components: string[];
  priority: string;
  status: string;
  created: string;
  resolved: string | null;
  comments: string[];
  attachmentTexts: string[];
  duplicateLinks: string[];
}

export interface Signal {
  name: string;
  score(a: Ticket, b: Ticket): number;
}

export interface ScoredPair {
  ticketA: string;
  ticketB: string;
  score: number;
  signalScores: Record<string, number>;
}

export interface Cluster {
  id: number;
  tickets: Ticket[];
  avgConfidence: number;
  confidenceLevel: 'High' | 'Medium' | 'Low';
  isCrossProject: boolean;
  mostRecentDate: string;
  title: string;
  dominantSignal: string;
  probableCause: string;
  suggestedAction: string;
  matchingSignals: string[];
  edges: ScoredPair[];
}
