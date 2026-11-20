"use client";

// The booking page: header, what can be done now, then the cards. On a phone
// it is one column in the order staff need it (when, WhatsApp, customer);
// from lg up, two columns.

import type { ApptStatus } from "@/lib/appointments/core";
import type { ApptEvent, ApptMessage } from "@/lib/appointments/server";
import { ApptHeader, StatusPill, TestModeNote } from "../ui";
import { BookingProvider, useBooking, type BookingData } from "./ctx";
import { ActionBar } from "./ActionBar";
import { AppointmentCard, StylistCard, ToldUsCard } from "./DetailCards";
import { CustomerCard, SendWhatsAppCard } from "./CustomerCards";
import { HistoryCard, MessagesCard } from "./LogCards";

export interface BookingViewProps extends BookingData {
  events: ApptEvent[];
  messages: ApptMessage[];
  others: Array<{ number: string; starts_at: string; status: ApptStatus }>;
}

export function BookingView({ events, messages, others, ...data }: BookingViewProps) {
  return (
    <BookingProvider data={data}>
      <Body events={events} messages={messages} others={others} />
    </BookingProvider>
  );
}

function Body({ events, messages, others }: Pick<BookingViewProps, "events" | "messages" | "others">) {
  const { appt: a, type, staff, automationOn, testMode } = useBooking();
  const staffName = (id: string | null) => (id ? staff.find((s) => s.id === id)?.name ?? "a former team member" : null);
  const moved = events.some((e) => e.kind === "move");
  return (
    <>
      <ApptHeader title={a.customer_name} eyebrow={`${a.number} · ${type?.name ?? a.type_id}`} right={<StatusPill status={a.status} />} />
      <ActionBar />
      <TestModeNote automationOn={automationOn} testMode={testMode} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 items-start">
        <div className="flex flex-col gap-4" style={{ minWidth: 0 }}>
          <AppointmentCard staffName={staffName} />
          <SendWhatsAppCard moved={moved} messages={messages} />
          <CustomerCard others={others} />
        </div>
        <div className="flex flex-col gap-4" style={{ minWidth: 0 }}>
          <StylistCard />
          <ToldUsCard />
          <MessagesCard messages={messages} />
          <HistoryCard events={events} />
        </div>
      </div>
    </>
  );
}
