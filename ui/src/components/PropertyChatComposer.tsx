import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { ArrowUp, AtSign, Loader2, X } from "lucide-react";
import { cn } from "../lib/utils";

export interface ComposerProperty {
  id: string;
  name: string;
  leadAgentId?: string | null;
  color?: string | null;
}

interface PropertyChatComposerProps {
  companyId: string;
  properties: ComposerProperty[];
  defaultPropertyId?: string | null;
  autoFocus?: boolean;
}

interface MentionRange {
  start: number;
  end: number;
}

function PropertyDot({ color }: { color?: string | null }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color || "var(--pm-orange)" }}
    />
  );
}

/**
 * A single, ChatGPT-style chatbox for property managers. They describe a change
 * in plain language and tag which website to change with `@`. Submitting creates
 * a request scoped to that property (assigned to its concierge agent) and drops
 * them into the conversation thread. The safety gate is enforced server-side on
 * create, so this uses the same POST as the full dialog.
 */
export function PropertyChatComposer({
  companyId,
  properties,
  defaultPropertyId,
  autoFocus,
}: PropertyChatComposerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const initialId =
    defaultPropertyId && properties.some((p) => p.id === defaultPropertyId)
      ? defaultPropertyId
      : properties.length === 1
        ? properties[0].id
        : null;

  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [needsProperty, setNeedsProperty] = useState(false);
  const mentionRange = useRef<MentionRange | null>(null);

  // Keep the selected property in sync if the sidebar preselects a different one.
  useEffect(() => {
    if (defaultPropertyId && properties.some((p) => p.id === defaultPropertyId)) {
      setSelectedId(defaultPropertyId);
    }
  }, [defaultPropertyId, properties]);

  const selected = useMemo(
    () => properties.find((p) => p.id === selectedId) ?? null,
    [properties, selectedId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? properties.filter((p) => p.name.toLowerCase().includes(q))
      : properties;
    return base.slice(0, 8);
  }, [properties, query]);

  // Grow the textarea with its content (up to a cap), like a chat input.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const detectMention = useCallback(
    (value: string, caret: number) => {
      const upto = value.slice(0, caret);
      const at = upto.lastIndexOf("@");
      if (at === -1) {
        setPickerOpen(false);
        return;
      }
      const precededOk = at === 0 || /\s/.test(value[at - 1] ?? "");
      const token = value.slice(at + 1, caret);
      if (!precededOk || token.includes("\n")) {
        setPickerOpen(false);
        return;
      }
      mentionRange.current = { start: at, end: caret };
      setQuery(token);
      setActiveIndex(0);
      setPickerOpen(true);
    },
    [],
  );

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    setNeedsProperty(false);
    detectMention(value, e.target.selectionStart ?? value.length);
  };

  const selectProperty = useCallback(
    (prop: ComposerProperty) => {
      setSelectedId(prop.id);
      setNeedsProperty(false);
      const range = mentionRange.current;
      if (range) {
        setText((prev) => prev.slice(0, range.start) + prev.slice(range.end));
      }
      mentionRange.current = null;
      setPickerOpen(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const caret = range?.start ?? el.value.length;
        el.setSelectionRange(caret, caret);
      });
    },
    [],
  );

  const openPicker = () => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    mentionRange.current = { start: caret, end: caret };
    setQuery("");
    setActiveIndex(0);
    setPickerOpen(true);
  };

  const createRequest = useMutation({
    mutationFn: async () => {
      const trimmed = text.trim();
      const title =
        trimmed.length > 140 ? `${trimmed.slice(0, 140).trimEnd()}…` : trimmed;
      return issuesApi.create(companyId, {
        title,
        description: trimmed,
        status: "todo",
        priority: "medium",
        workMode: "standard",
        ...(selected ? { projectId: selected.id } : {}),
        ...(selected?.leadAgentId ? { assigneeAgentId: selected.leadAgentId } : {}),
      });
    },
    onSuccess: (issue) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      setText("");
      navigate(`/issues/${issue.identifier ?? issue.id}`);
    },
  });

  const canSubmit =
    text.trim().length > 0 && Boolean(selected) && !createRequest.isPending;

  const submit = () => {
    if (createRequest.isPending) return;
    if (!text.trim()) return;
    if (!selected) {
      setNeedsProperty(true);
      openPicker();
      return;
    }
    createRequest.mutate();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectProperty(filtered[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPickerOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const hasProperties = properties.length > 0;

  return (
    <div className="relative">
      {pickerOpen && filtered.length > 0 && (
        <div
          role="listbox"
          className="pm-pop absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-2xl border border-border bg-popover p-1.5 shadow-[0_24px_60px_-24px_rgba(30,42,64,0.45)]"
        >
          <p className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
            Choose a property
          </p>
          {filtered.map((prop, i) => (
            <button
              key={prop.id}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => selectProperty(prop)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[14px] transition-colors duration-150",
                i === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
              )}
            >
              <PropertyDot color={prop.color} />
              <span className="min-w-0 flex-1 truncate">{prop.name}</span>
            </button>
          ))}
        </div>
      )}

      <div
        className={cn(
          "rounded-[1.6rem] border bg-card p-3 shadow-[0_2px_10px_-6px_rgba(30,42,64,0.15)] transition-all duration-300 ease-out",
          "focus-within:-translate-y-0.5 focus-within:border-primary/40 focus-within:shadow-[0_22px_54px_-26px_rgba(30,42,64,0.5)]",
          needsProperty ? "border-primary/50" : "border-border",
        )}
      >
        {selected ? (
          <button
            type="button"
            onClick={openPicker}
            className="pm-chip-in mb-1 ml-1 inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[13px] font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent/70"
            title="Change property"
          >
            <PropertyDot color={selected.color} />
            {selected.name}
            <X className="h-3 w-3 opacity-50" />
          </button>
        ) : null}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            hasProperties
              ? "Describe the change you'd like…  (type @ to pick a property)"
              : "No properties available yet."
          }
          disabled={!hasProperties || createRequest.isPending}
          className="block max-h-[220px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[15px] leading-7 text-foreground outline-none placeholder:text-muted-foreground/70"
        />

        <div className="mt-1 flex items-center justify-between gap-3 pl-1">
          <button
            type="button"
            onClick={openPicker}
            disabled={!hasProperties}
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-40"
          >
            <AtSign className="h-3.5 w-3.5" />
            {selected ? "Change property" : "Choose property"}
          </button>

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            aria-label="Send request"
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white shadow-sm transition-all duration-200",
              canSubmit
                ? "pm-accent-bg hover:scale-105 hover:shadow-md active:scale-95"
                : "cursor-not-allowed bg-muted-foreground/25",
            )}
          >
            {createRequest.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      <p className="mt-2 h-4 pl-3 text-[12px] text-muted-foreground/80">
        {createRequest.isError
          ? "Something went wrong. Please try again."
          : needsProperty
            ? "Pick a property with @ to send your request."
            : ""}
      </p>
    </div>
  );
}
