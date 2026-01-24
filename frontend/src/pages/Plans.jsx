// frontend/src/pages/Plans.jsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getProfile } from "../utils/profile";

function loadSaved(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function focusLabel(focus) {
  const f = String(focus || "work");
  return f.charAt(0).toUpperCase() + f.slice(1);
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function clearStorageByPrefix(storage, prefix) {
  const keysToRemove = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(prefix)) keysToRemove.push(k);
  }
  keysToRemove.forEach((k) => storage.removeItem(k));
}

function clearUserPlanDataEverywhere(userId) {
  // All Plans + checkins
  localStorage.removeItem(`bc_plans_${userId}`);
  localStorage.removeItem(`bc_checkins_${userId}`);

  // Conversation plans (sessionStorage) across ALL focuses
  clearStorageByPrefix(sessionStorage, `bc_conv_plans_${userId}_`);

  // OPTIONAL: also clear per-need chat history across ALL focuses/needs
  // Comment out if you want to keep chat history.
  clearStorageByPrefix(localStorage, `bc_chat_${userId}_`);

  // OPTIONAL: clear active need selection used for daily check-ins
  clearStorageByPrefix(localStorage, `bc_active_need_${userId}_`);
}

const FOCUS_OPTIONS = ["all", "work", "relationship", "appearance", "social"];

export default function Plans() {
  const navigate = useNavigate();

  const [profile, setProfile] = useState(() => getProfile() || {});
  useEffect(() => {
    setProfile(getProfile() || {});
  }, []);

  const userId = profile?.user_id || "local-dev";
  const plansKey = `bc_plans_${userId}`;
  const checkinsKey = `bc_checkins_${userId}`;

  const [plans, setPlans] = useState([]);
  const [checkins, setCheckins] = useState([]);
  const [filter, setFilter] = useState("all");

  const [plansHydrated, setPlansHydrated] = useState(false);
  const [checkinsHydrated, setCheckinsHydrated] = useState(false);

  // Hydrate
  useEffect(() => {
    const p = loadSaved(plansKey, []);
    const c = loadSaved(checkinsKey, []);
    setPlans(Array.isArray(p) ? p : []);
    setCheckins(Array.isArray(c) ? c : []);
    setPlansHydrated(true);
    setCheckinsHydrated(true);
  }, [plansKey, checkinsKey]);

  // Persist
  useEffect(() => {
    if (!plansHydrated) return;
    save(plansKey, plans);
  }, [plansKey, plans, plansHydrated]);

  useEffect(() => {
    if (!checkinsHydrated) return;
    save(checkinsKey, checkins);
  }, [checkinsKey, checkins, checkinsHydrated]);

  // Keep in sync when user returns to this tab or another tab changes storage
  useEffect(() => {
    const refreshFromStorage = () => {
      const p = loadSaved(plansKey, []);
      const c = loadSaved(checkinsKey, []);
      setPlans(Array.isArray(p) ? p : []);
      setCheckins(Array.isArray(c) ? c : []);
    };

    const onStorage = (e) => {
      if (e.key === plansKey || e.key === checkinsKey) refreshFromStorage();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refreshFromStorage);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refreshFromStorage);
    };
  }, [plansKey, checkinsKey]);

  const getTodayStatus = (planId) => {
    const d = todayStr();
    const row = checkins.find((c) => c.planId === planId && c.date === d);
    return row?.status || "";
  };

  const upsertTodayCheckin = (planId, status) => {
    const d = todayStr();
    setCheckins((prev) => {
      const exists = prev.find((c) => c.planId === planId && c.date === d);
      if (exists) {
        return prev.map((c) => (c.planId === planId && c.date === d ? { ...c, status } : c));
      }
      return [...prev, { id: uid("chk"), planId, date: d, status }];
    });
  };

  const deletePlan = (planId) => {
    const ok = window.confirm("Delete this plan? This cannot be undone.");
    if (!ok) return;
    setPlans((prev) => prev.filter((p) => p?.id !== planId));
    setCheckins((prev) => prev.filter((c) => c?.planId !== planId));
  };

  const acceptedPlansAll = useMemo(() => {
    const arr = Array.isArray(plans) ? plans : [];
    return arr.filter((p) => p?.acceptedAt || p?.accepted === true);
  }, [plans]);

  const acceptedPlans =
    filter === "all" ? acceptedPlansAll : acceptedPlansAll.filter((p) => p.focus === filter);

  // Confidence key per plan (focus + need)
  function confidenceKeyForPlan(plan) {
    const focus = plan?.focus || "work";

    // Backward compatible: if no need info, fallback to old focus-level key
    if (!plan?.needKey && !plan?.needLabel) {
      return `bc_conf_${userId}_${focus}`;
    }

    const needKey = String(plan?.needKey || "").trim();
    const needLabel = String(plan?.needLabel || "").trim();

    if (needKey === "custom") {
      const slug = slugify(needLabel) || "custom";
      return `bc_conf_${userId}_${focus}_custom_${slug}`;
    }

    // normal need keys: interview, presentation, etc.
    return `bc_conf_${userId}_${focus}_${needKey || "interview"}`;
  }

  function getConfidenceForPlan(plan) {
    const key = confidenceKeyForPlan(plan);
    const conf = loadSaved(key, null);
    if (!conf || typeof conf !== "object") return null;

    const baseline = typeof conf.baseline === "number" ? conf.baseline : null;
    const history = Array.isArray(conf.history) ? conf.history : [];
    const t = todayStr();

    const todayRow = history.find((x) => x?.date === t);
    const today = todayRow && typeof todayRow.level === "number" ? todayRow.level : null;

    const latestRow = history.length > 0 ? history[history.length - 1] : null;
    const latest = latestRow && typeof latestRow.level === "number" ? latestRow.level : null;

    const delta =
      baseline != null && latest != null ? Math.round((latest - baseline) * 10) / 10 : null;

    return { key, baseline, today, latest, delta, history };
  }

  // Summary by focus + need
  const confidenceSummary = useMemo(() => {
    const map = new Map();

    for (const p of acceptedPlansAll) {
      const focus = p?.focus || "work";
      const needKey = p?.needKey || "(legacy)";
      const needLabel =
        p?.needLabel || (needKey === "(legacy)" ? "Focus confidence (legacy)" : needKey);

      const conf = getConfidenceForPlan(p);
      const id = `${focus}__${needKey}__${needLabel}`;

      if (!map.has(id) || (conf && conf.latest != null)) {
        map.set(id, { focus, needKey, needLabel, conf });
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      const fa = String(a.focus);
      const fb = String(b.focus);
      if (fa !== fb) return fa.localeCompare(fb);
      return String(a.needLabel).localeCompare(String(b.needLabel));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedPlansAll, userId]);

  const styles = {
    page: { maxWidth: 980, margin: "0 auto", padding: 16, color: "var(--text-primary, #111827)" },
    topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" },
    btn: {
      height: 36,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      background: "var(--bg-page, #ffffff)",
      color: "var(--text-primary, #111827)",
      padding: "0 12px",
      cursor: "pointer",
    },
    dangerBtn: {
      height: 32,
      borderRadius: 10,
      border: "1px solid #fecaca",
      background: "#fff",
      color: "#b91c1c",
      padding: "0 10px",
      cursor: "pointer",
    },
    card: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 },
    title: { fontWeight: 900, fontSize: 20, marginBottom: 6 },
    muted: { opacity: 0.7 },
    row: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
    small: { fontSize: 12, opacity: 0.8 },
    pill: {
      display: "inline-block",
      fontSize: 12,
      padding: "2px 8px",
      borderRadius: 999,
      border: "1px solid #e5e7eb",
      opacity: 0.9,
      marginLeft: 8,
    },
    resources: { marginTop: 6, fontSize: 13, opacity: 0.92 },
    linkList: { margin: "6px 0 0", paddingLeft: 18 },
  };

  const stillLoading = !(plansHydrated && checkinsHydrated);

  const clearAll = () => {
    const ok = window.confirm(
      "Clear ALL your saved plans (All Plans + Plans from Conversation + chat history)? This cannot be undone."
    );
    if (!ok) return;

    clearUserPlanDataEverywhere(userId);

    // refresh UI immediately
    setPlans([]);
    setCheckins([]);
  };

  return (
    <div style={styles.page}>
      <div style={styles.topbar}>
        <div>
          <div style={styles.title}>Your All Plans</div>
          <div style={{ ...styles.muted, marginBottom: 12 }}>Track plans across all focuses. Check in daily.</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={styles.btn} onClick={() => navigate("/chat")}>
            Back to Chat
          </button>
          <button style={styles.dangerBtn} onClick={clearAll} title="Clears saved plans + conversation plans">
            Clear all saved data
          </button>
        </div>
      </div>

      {/* Confidence summary (per focus + need) */}
      <div style={styles.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>Confidence summary</div>
          <span style={styles.pill}>1–10 scale</span>
          <div style={styles.muted}>Based on your check-ins from Chat.</div>
        </div>

        {confidenceSummary.length === 0 ? (
          <div style={{ ...styles.muted, marginTop: 10 }}>No confidence data yet.</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {confidenceSummary.map((row, idx) => {
              const conf = row.conf;
              const baseline = conf?.baseline;
              const today = conf?.today;
              const latest = conf?.latest;
              const delta = conf?.delta;

              const deltaText =
                typeof delta === "number"
                  ? delta > 0
                    ? `(+${delta})`
                    : delta < 0
                    ? `(${delta})`
                    : "(no change)"
                  : "";

              const histText = Array.isArray(conf?.history)
                ? conf.history
                    .slice(-6)
                    .map((x) => (typeof x?.level === "number" ? x.level : "?"))
                    .join(" → ")
                : "";

              return (
                <div key={idx} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>
                    {focusLabel(row.focus)} • {row.needLabel}
                    <span style={styles.pill}>{row.focus}</span>
                  </div>

                  {baseline == null && latest == null ? (
                    <div style={styles.muted}>No confidence records yet for this plan.</div>
                  ) : (
                    <div style={{ lineHeight: 1.6 }}>
                      <div>Baseline: {baseline != null ? `${baseline}/10` : "—"}</div>
                      <div>Today: {today != null ? `${today}/10` : "—"}</div>
                      <div>
                        Latest: {latest != null ? `${latest}/10` : "—"}{" "}
                        {baseline != null && latest != null ? deltaText : ""}
                      </div>
                      {histText ? <div>History: {histText}</div> : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <b>Filter:</b>{" "}
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FOCUS_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {f === "all" ? "All focuses" : f}
            </option>
          ))}
        </select>
      </div>

      {stillLoading ? (
        <div style={styles.muted}>Loading your plans…</div>
      ) : acceptedPlans.length === 0 ? (
        <div style={styles.muted}>No accepted plans yet.</div>
      ) : (
        acceptedPlans.map((p) => {
          const conf = getConfidenceForPlan(p);
          const baseline = conf?.baseline;
          const today = conf?.today;
          const latest = conf?.latest;
          const delta = conf?.delta;

          const deltaText =
            typeof delta === "number"
              ? delta > 0
                ? `(+${delta})`
                : delta < 0
                ? `(${delta})`
                : "(no change)"
              : "";

          const headerNeed = p?.needLabel ? ` • ${p.needLabel}` : "";

          return (
            <div key={p.id} style={styles.card}>
              <div style={styles.row}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 900 }}>
                    {p.title}
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                      {" "}
                      ({p.focus}
                      {headerNeed})
                    </span>
                  </div>

                  <div style={styles.small}>
                    Accepted: {p.acceptedAt ? new Date(p.acceptedAt).toLocaleString() : "—"}
                  </div>

                  <div style={{ marginTop: 8, lineHeight: 1.6 }}>
                    <b>Confidence</b>{" "}
                    <span style={styles.small}>
                      — Baseline: {baseline != null ? `${baseline}/10` : "—"} • Today:{" "}
                      {today != null ? `${today}/10` : "—"} • Latest:{" "}
                      {latest != null ? `${latest}/10` : "—"}{" "}
                      {baseline != null && latest != null ? deltaText : ""}
                    </span>
                  </div>
                </div>

                <button style={styles.dangerBtn} onClick={() => deletePlan(p.id)} title="Delete this plan">
                  Delete
                </button>
              </div>

              <div style={{ marginTop: 10 }}>
                <b>Today’s status ({todayStr()}):</b>
                <div style={{ marginTop: 6 }}>
                  <select value={getTodayStatus(p.id)} onChange={(e) => upsertTodayCheckin(p.id, e.target.value)}>
                    <option value="">Select…</option>
                    <option value="not_started">Not started</option>
                    <option value="in_progress">In progress</option>
                    <option value="complete">Complete</option>
                  </select>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <b>Steps</b>
                <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {(p.steps || []).map((s) => (
                    <li key={s.id} style={{ marginBottom: 10 }}>
                      <div>{s.label}</div>

                      {Array.isArray(s.resources) && s.resources.length > 0 && (
                        <div style={styles.resources}>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>Learning links</div>
                          <ul style={styles.linkList}>
                            {s.resources.slice(0, 3).map((r, idx) => (
                              <li key={idx} style={{ marginBottom: 4 }}>
                                <a href={r.url} target="_blank" rel="noreferrer">
                                  {r.title}
                                </a>
                                {r.type ? <span style={{ opacity: 0.75 }}> ({r.type})</span> : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
