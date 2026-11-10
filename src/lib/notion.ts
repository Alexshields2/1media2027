// IDs of the 1Media OS databases in Notion. Agents get these in their prompt so they
// go straight to the right database instead of searching the workspace.
// These are identifiers only; access still needs the connected Notion account.

export const NOTION = {
  osHome: "e0e98ec7-8dd1-831f-a03f-01b7ef82981b", // 1Media Operating System 2.0
  databases: {
    clientPortals: "collection://f0598ec7-8dd1-8365-bc03-877e4a61c759",
    paymentCollection: "collection://1596ffdf-32f4-441c-b673-6bb8dd6c43af",
    tasksTracker: "collection://33998ec7-8dd1-83d8-99b1-878a49f0446d",
    clientTrafficLight: "collection://07c3451a-038c-4f03-bd5e-4ccf0724203c",
    monthlyReportClients: "collection://51b99f9e-6c93-4e48-8208-2f7b8de6752d",
    weeklyReportsLog: "collection://022773b2-921d-427e-8f96-9e0ec172040c",
    monthEndReports: "collection://39e98ec7-8dd1-8038-93db-000b214543c6",
    meetingNotes: "collection://70198ec7-8dd1-823f-a233-872c63d5b472",
    clientProjects: "collection://fbc98ec7-8dd1-8339-8fb8-07fde5c5ca25",
    salesCrm: "collection://0ff98ec7-8dd1-83d9-b1fc-074d3d9d0316",
    expenses: "collection://09598ec7-8dd1-83a1-bfc7-07938704e061",
    team: "collection://9f298ec7-8dd1-8360-9d6f-0781284bebf1",
  },
  pages: {
    onboardingSop: "3de98ec7-8dd1-8107-9e97-f296108df0f0",
    weeklyReportSop: "40c98ec7-8dd1-8150-935d-ccc808561666",
    monthlyReportPrompt: "39e98ec7-8dd1-80c0-aa9e-f274ee8500e5",
    kpiForClients: "3a398ec7-8dd1-80bb-baa7-fe9ea1579cb8",
  },
} as const;

/** Rendered into every agent's system prompt. */
export function notionMap(): string {
  const dbs = Object.entries(NOTION.databases)
    .map(([k, v]) => `- ${k}: ${v.replace("collection://", "")}`)
    .join("\n");
  const pages = Object.entries(NOTION.pages)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return `Notion workspace "1Media Operating System 2.0" (${NOTION.osHome}).\nDatabases (data source IDs):\n${dbs}\nKey pages:\n${pages}`;
}
