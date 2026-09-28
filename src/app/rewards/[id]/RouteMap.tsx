"use client";

import dynamic from "next/dynamic";
import type { QuestPin } from "@/components/QuestMap";

const QuestMap = dynamic(() => import("@/components/QuestMap"), {
  ssr: false,
  loading: () => <div className="h-[360px] w-full animate-pulse rounded-2xl bg-surface-2" />,
});

export function RouteMap({ route, quests }: { route: [number, number][]; quests: QuestPin[] }) {
  return <QuestMap quests={quests} route={route} className="h-[360px] w-full rounded-2xl" />;
}
