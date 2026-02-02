import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState, useMemo } from "react";
import { getProfile } from "../utils/profile";

// ✅ Put BOTH public mp4 URLs here
const VIDEO_URLS = {
  mira: "https://res.cloudinary.com/dwi9flivx/video/upload/v1768800319/intro_female_xvsjq9.mp4",
  kai: "https://res.cloudinary.com/dwi9flivx/video/upload/v1768881071/male_avatar_with_script_xvhesy.mp4",
};

export default function IntroVideo() {
  const navigate = useNavigate();
  const videoRef = useRef(null);

  // Default to sound ON (isMuted = false)
  const [isMuted, setIsMuted] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [duration, setDuration] = useState(0);

  const profile = getProfile() || {};
  // Use coachId or fallback to coachAvatar, then default to mira
  const coachId = profile?.coachId || profile?.coachAvatar || "mira";

  const videoSrc = useMemo(() => {
    return VIDEO_URLS[coachId] || VIDEO_URLS.mira;
  }, [coachId]);

  const goNext = () => {
    navigate("/onboarding");
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
    }
  };

  // Video functionality
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleEnded = () => goNext();
    const handleTimeUpdate = () => {
      if (video.duration) {
        setDuration(video.duration);
        setTimeLeft(Math.max(0, video.duration - video.currentTime));
      }
    };
    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setTimeLeft(video.duration);
    };

    video.addEventListener("ended", handleEnded);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);

    return () => {
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle source change
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Start muted to ensure autoplay works
    video.muted = true;
    setIsMuted(true);

    video.load();
    video.play()
      .then(() => {
        // Once playing, try to unmute
        video.muted = false;
        setIsMuted(false);
      })
      .catch((err) => {
        console.warn("Autoplay with sound blocked, keeping muted for now.", err);
        // Fallback: stay muted if blocked
        video.muted = true;
        setIsMuted(true);
      });
  }, [videoSrc]);

  // Format time (MM:SS)
  const formatTime = (seconds) => {
    if (!seconds) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div style={styles.container}>
      <video
        ref={videoRef}
        src={videoSrc}
        autoPlay
        muted={isMuted}
        playsInline
        preload="auto"
        controls={false}
        style={styles.video}
      />

      {/* Controls Container */}
      <div style={styles.controlsContainer}>
        {/* Skip button at main position */}
        <button style={styles.skipBtn} onClick={goNext}>
          Skip
        </button>

        {/* Mute/Unmute under Skip */}
        <div style={styles.subControls}>
          {/* Countdown */}
          <span style={styles.timer}>
            {formatTime(timeLeft)}
          </span>

          <button style={styles.iconBtn} onClick={toggleMute}>
            {isMuted ? "🔇 Unmute" : "🔊 Mute"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  video: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    objectPosition: "center",
  },
  controlsContainer: {
    position: "absolute",
    right: 20,
    top: 20,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end", // Align to right
    gap: 8,
    zIndex: 10,
  },
  skipBtn: {
    padding: "10px 20px",
    borderRadius: 20,
    border: "none",
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
    cursor: "pointer",
    backdropFilter: "blur(4px)",
    transition: "background 0.2s",
  },
  subControls: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "rgba(0,0,0,0.4)",
    padding: "6px 12px",
    borderRadius: 12,
    backdropFilter: "blur(4px)",
  },
  timer: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "monospace",
    fontWeight: 600,
    minWidth: "32px",
    textAlign: "right",
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 500,
    padding: 0,
    opacity: 0.9,
  },
};
