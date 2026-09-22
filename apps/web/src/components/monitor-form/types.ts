export type MonitorAssertionValue = { kind: string; target: string; operator: string; value: string };

export type MonitorFormValues = {
  name: string;
  type: string;
  url: string;
  method: string;
  headers: string;
  body: string;
  intervalSeconds: number;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  expectedStatusCodes: string;
  regions: string[];
  quorumRatio: number;
  minRegionsRequired: number;
  confirmationFailures: number;
  confirmationSuccesses: number;
  degradedThresholdMs: string;
  groupName: string;
  tags: string;
  assertions: MonitorAssertionValue[];
};

export const EMPTY_MONITOR: MonitorFormValues = {
  name: "",
  type: "http",
  url: "https://",
  method: "GET",
  headers: "",
  body: "",
  intervalSeconds: 60,
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 5,
  expectedStatusCodes: "200,201,204",
  regions: ["bom", "fra", "iad"],
  quorumRatio: 0.6,
  minRegionsRequired: 2,
  confirmationFailures: 2,
  confirmationSuccesses: 2,
  degradedThresholdMs: "",
  groupName: "",
  tags: "",
  assertions: [],
};
