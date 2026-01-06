import { Link } from "react-router-dom";

export default function Welcome() {
  return (
    <div style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 8 }}>Build Confidence</h1>
      <p style={{ marginTop: 0, lineHeight: 1.5 }}>
        Your friendly coach to grow confidence step by step.
      </p>

      <div style={{ marginTop: 16 }}>
        <Link to="/onboarding">
          <button style={{ padding: "10px 14px", cursor: "pointer" }}>
            Meet Mira →
          </button>
        </Link>
      </div>
    </div>
  );
}
