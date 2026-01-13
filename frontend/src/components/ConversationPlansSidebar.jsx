export default function ConversationPlansSidebar({ plans = [], focus }) {
  const styles = {
    title: { fontWeight: 900, marginBottom: 6 },
    muted: { opacity: 0.75 },
    card: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 10, background: "#fff" },
    small: { fontSize: 12, opacity: 0.8 },
  };

  return (
    <div>
      <div style={styles.title}>Plans from this conversation</div>
      <div style={{ ...styles.muted, marginBottom: 12 }}>
        Saved plans for focus: <b>{focus}</b>
      </div>

      {plans.length === 0 ? (
        <div style={styles.muted}>No accepted plans in this conversation yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {plans.slice(0, 50).map((p) => (
            <div key={p.id} style={styles.card}>
              <div style={{ fontWeight: 900 }}>{p.title}</div>
              {p.acceptedAt && (
                <div style={styles.small}>Saved: {new Date(p.acceptedAt).toLocaleString()}</div>
              )}
              <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {(p.steps || []).map((s) => (
                  <li key={s.id} style={{ marginBottom: 6 }}>
                    {s.label}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
