export const config = {
  signalWeights: {
    textSimilarity: 0.30,
    errorPattern: 0.25,
    componentLabel: 0.15,
    affectedArea: 0.15,
    temporalProximity: 0.15,
  },
  matchThreshold: 0.4,
  confidenceThresholds: {
    high: 0.7,
    medium: 0.5,
  },
  temporalWindowDays: 14,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  lookbackMonths: 60,
  maxTickets: 2000,
  maxAttachmentBytes: 5 * 1024 * 1024,
  clusterSizeWarning: 20,
  jiraPageSize: 100,
  projectKeywords: {
    CWM: ['claim', 'policy', 'insured', 'grower', 'crop', 'peril', 'coverage', 'premium', 'adjustment'],
    DMS: ['document', 'upload', 'attachment', 'scan', 'file', 'template', 'print', 'report'],
    RRS: ['resource', 'road', 'permit', 'authorization', 'tenure', 'forestry', 'cutblock', 'silviculture'],
  } as Record<string, string[]>,
};
