import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getProfile } from "../utils/profile";

function loadSaved(key, fallback = []) {
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

const FOCUS_OPTIONS = ["all", "work", "relationship", "appearance", "social"];

export default function Plans() {
  const navigate = useNavigate();

  // keep profile fresh
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

  // hydration guards
  const [plansHydrated, setPlansHydrated] = useState(false);
  const [checkinsHydrated, setCheckinsHydrated] = useState(false);

  // hydrate whenever keys change
  useEffect(() => {
    setPlansHydrated(false);
    setCheckinsHydrated(false);

    const p = loadSaved(plansKey, []);
    const c = loadSaved(checkinsKey, []);

    setPlans(Array.isArray(p) ? p : []);
    setCheckins(Array.isArray(c) ? c : []);

    setPlansHydrated(true);
    setCheckinsHydrated(true);
  }, [plansKey, checkinsKey]);

  // persist checkins only AFTER hydration
  useEffect(() => {
    if (!checkinsHydrated) return;
    save(checkinsKey, checkins);
  }, [checkinsKey, checkins, checkinsHydrated]);

  // refresh from storage when you return to this tab/page
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
        return prev.map((c) =>
          c.planId === planId && c.date === d ? { ...c, status } : c
        );
      }
      return [...prev, { id: uid("chk"), planId, date: d, status }];
    });
  };

  // accept both formats (acceptedAt OR accepted:true)
  const acceptedPlansAll = useMemo(() => {
    const arr = Array.isArray(plans) ? plans : [];
    return arr.filter((p) => p?.acceptedAt || p?.accepted === true);
  }, [plans]);

  const acceptedPlans =
    filter === "all"
      ? acceptedPlansAll
      : acceptedPlansAll.filter((p) => p.focus === filter);

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
    card: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 },
    title: { fontWeight: 900, fontSize: 20, marginBottom: 6 },
    muted: { opacity: 0.7 },
  };

  const stillLoading = !(plansHydrated && checkinsHydrated);

  return (
    <div style={styles.page}>
      <div style={styles.topbar}>
        <div>
          <div style={styles.title}>Your Plans</div>
          <div style={{ ...styles.muted, marginBottom: 12 }}>
            Track plans across all focuses. Check in daily.
          </div>
        </div>

        <button style={styles.btn} onClick={() => navigate("/chat")}>
          Back to Chat
        </button>
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
        <div style={styles.muted}>
          No accepted plans yet.
          <div style={{ marginTop: 8, fontSize: 12 }}>
            Debug keys: <code>{plansKey}</code>
          </div>
        </div>
      ) : (
        acceptedPlans.map((p) => (
          <div key={p.id} style={styles.card}>
            <div style={{ fontWeight: 900 }}>
              {p.title}{" "}
              <span style={{ fontSize: 12, opacity: 0.7 }}>({p.focus})</span>
            </div>

            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Accepted: {p.acceptedAt ? new Date(p.acceptedAt).toLocaleString() : "—"}
            </div>

            <div style={{ marginTop: 10 }}>
              <b>Today’s status ({todayStr()}):</b>
              <div style={{ marginTop: 6 }}>
                <select
                  value={getTodayStatus(p.id)}
                  onChange={(e) => upsertTodayCheckin(p.id, e.target.value)}
                >
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
                  <li key={s.id} style={{ marginBottom: 6 }}>
                    {s.label}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
