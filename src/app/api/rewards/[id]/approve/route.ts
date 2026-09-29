import { approvalHandlers } from "@/lib/approval-route";

// The checkout loop runs in after(); give it room on Vercel.
export const maxDuration = 300;

export const { GET, POST } = approvalHandlers("approve");
