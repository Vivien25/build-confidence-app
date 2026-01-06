import { useEffect, useState } from "react";
import axios from "axios";
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export default function Progress(){
  const [ratings, setRatings] = useState([]);
  useEffect(()=>{
    axios.get(`${API_BASE}/progress/me`).then(r=>setRatings(r.data.ratings||[]));
  },[]);
  return (
    <div style={{padding:24}}>
      <h2>Your Confidence Growth</h2>
      <p>Ratings: {ratings.join(", ") || "no data yet"}</p>
      <p>🔥 Streak: 3 days in a row</p>
      <p>🏅 Badge: Beginner Speaker</p>
    </div>
  );
}
