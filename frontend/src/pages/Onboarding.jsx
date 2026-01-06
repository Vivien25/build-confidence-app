import { Link } from "react-router-dom";

const btnStyle = {
  width: "100%",
  padding: "12px",
  cursor: "pointer"
};

export default function Onboarding() {
  return (
    <div style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
      <h2>Which area do you want to start with?</h2>

      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        <button style={btnStyle}>Appearance</button>
        <button style={btnStyle}>Social</button>
        <button style={btnStyle}>Relationship</button>

        <Link to="/chat" style={{ textDecoration: "none" }}>
          <button style={btnStyle}>Work</button>
        </Link>
      </div>
    </div>
  );
}
