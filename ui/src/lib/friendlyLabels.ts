const STATUS_LABELS: Record<string, string> = {
  backlog: "Pending",
  todo: "Pending",
  in_progress: "In Progress",
  in_review: "Ready for Review",
  done: "Complete",
  blocked: "On Hold",
};

export function friendlyStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function friendlyStatusColor(status: string): string {
  switch (status) {
    case "in_review":
      return "bg-amber-100 text-amber-800";
    case "in_progress":
      return "bg-blue-100 text-blue-800";
    case "done":
      return "bg-green-100 text-green-800";
    case "blocked":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

export interface StatusMeta {
  label: string;
  /** Tailwind classes for a soft pill (background + text + ring). */
  pill: string;
  /** Tailwind background class for the status dot. */
  dot: string;
}

const STATUS_META: Record<string, StatusMeta> = {
  in_review: {
    label: "Ready for Review",
    pill: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200/70",
    dot: "bg-amber-500",
  },
  in_progress: {
    label: "In Progress",
    pill: "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200/70",
    dot: "bg-sky-500",
  },
  done: {
    label: "Complete",
    pill: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/70",
    dot: "bg-emerald-500",
  },
  blocked: {
    label: "On Hold",
    pill: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200/70",
    dot: "bg-rose-500",
  },
};

const PENDING_META: StatusMeta = {
  label: "Pending",
  pill: "bg-stone-100 text-stone-600 ring-1 ring-inset ring-stone-200/70",
  dot: "bg-stone-400",
};

export function friendlyStatusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? PENDING_META;
}
