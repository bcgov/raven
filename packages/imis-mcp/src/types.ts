/** A single server record from the IMIS CSV export. */
export interface ImisServer {
  serverName: string;
  fullName: string;
  aliasName: string;
  description: string;
  businessArea: string;
  pOrV: string;
  status: string;
  type: string;
  primaryIp: string;
  totalIps: string;
  zone: string;
  subnet: string;
  vlan: string;
  physicalLocation: string;
  os: string;
  os1: string;
  os2: string;
  os3: string;
  osBits: string;
  buildDate: string;
  retireDate: string;
  lastBootDate: string;
  makeModel: string;
  coreCpu: string;
  cpuType: string;
  ram: string;
  ohCoding: string;
  citrix: string;
  web: string;
  iis: string;
  ftp: string;
  smtp: string;
  internalDisk: string;
  tier0: string;
  tier1: string;
  tier2: string;
  tier3: string;
  external: string;
  otherStorage: string;
  hardwareEol: string;
  serialNumber: string;
  item1: string;
  content1: string;
  item2: string;
  content2: string;
  item3: string;
  content3: string;
  item4: string;
  content4: string;
  item5: string;
  content5: string;
  item6: string;
  content6: string;
  flag1: string;
  flag2: string;
  flag3: string;
  flag4: string;
  flag5: string;
  flag6: string;
  flag7: string;
  flag8: string;
  imisAgent: string;
  agentStatus: string;
  agentUpdate: string;
  imisControl: string;
  agentAccount: string;
  orderIStore: string;
  retireIStore: string;
  notes: string;
  lastUpdate: string;
}

/** Parameters for searching the IMIS inventory. */
export interface SearchParams {
  query?: string;
  type?: string;
  status?: string;
  businessArea?: string;
  os?: string;
  zone?: string;
  includeRetired?: boolean;
}

/** Result from SSH command execution. */
export interface SshResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
