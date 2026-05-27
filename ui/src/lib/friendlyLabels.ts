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
