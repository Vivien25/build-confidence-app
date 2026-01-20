🌐 Build Confidence Frontend
A modern, fast, and modular frontend built with React 19, Vite, and React Router 7.
This application powers the user-facing experience of the Build Confidence App, including onboarding, focus mode, chat interactions, progress tracking, and personalized plans.

🚀 Features
React 19 with concurrent rendering

Vite for instant dev server and optimized builds

React Router 7 for clean, declarative routing

Axios for backend API communication

LocalStorage-based profile system

Reusable UI components (plans sidebar, quick help, progress view)

ESLint Flat Config for consistent code quality

Hot Module Reloading (HMR) via React Fast Refresh

Project Structure：
frontend/
│
├── public/                     # Static assets
│
├── src/
│   ├── main.jsx                # Application entrypoint
│   ├── App.jsx                 # Router + top-level navigation
│   │
│   ├── pages/                  # Page-level components
│   │     ├── Welcome.jsx
│   │     ├── IntroVideo.jsx
│   │     ├── Onboarding.jsx
│   │     ├── Focus.jsx
│   │     ├── Chat.jsx
│   │     ├── Plans.jsx
│   │     ├── Progress.jsx
│   │     ├── QuickHelp.jsx
│   │     └── Work.jsx
│   │
│   ├── components/             # Reusable UI components
│   │     └── ConversationPlansSidebar.jsx
│   │
│   ├── utils/                  # Utility modules
│   │     ├── avatars.js
│   │     └── profile.js
│   │
│   ├── assets/                 # Images, icons, avatars
│   └── index.css               # Global styles
│
├── package.json
├── vite.config.js
├── eslint.config.js
└── README.md

Routing Overview
Your routing is defined in App.jsx:

Route	      Component	      Purpose
/	      Welcome	      Landing screen
/intro	      IntroVideo      Meet the AI coach
/onboarding   Onboarding      User profile setup
/focus	      Focus	      Select or refine focus area
/chat	      Chat	      AI chat interface
/plans	      Plans	      View saved plans
*	      Redirect → /    Catch-all fallback
This structure supports a clean onboarding → focus → chat → plan flow.

🧩 Pages Overview
Welcome.jsx
Landing page introducing the Build Confidence experience.

IntroVideo.jsx
Introductory video or animated introduction to the AI coach.

Onboarding.jsx
Collects user profile information and stores it via utils/profile.js.

Focus.jsx
Allows users to choose or refine their confidence focus area.

Chat.jsx
Main conversational interface with the AI coach.

Plans.jsx
Displays saved plans and integrates with ConversationPlansSidebar.

Progress.jsx
Fetches user progress from backend:
axios.get(`${API_BASE}/progress/me`)
Shows ratings, streaks, and badges.

QuickHelp.jsx
Provides instant confidence-boosting tips.

Work.jsx
A protected page that redirects to onboarding if no profile exists.

🧰 Components
ConversationPlansSidebar.jsx
A sidebar component that displays accepted plans from the current conversation.

Shows plan title, timestamp, and steps

Supports up to 50 plans

Used in chat and plan review flows

🧰 Utilities
avatars.js
Defines avatar metadata for users and the AI coach.

profile.js
LocalStorage-based profile persistence:

getProfile()

saveProfile(profile)

clearProfile()

Used during onboarding and session validation.

🔌 Backend Integration
The frontend communicates with the FastAPI backend at:
http://localhost:8000
API_BASE is configurable via:
VITE_API_BASE=http://localhost:8000
⚙️ Development Setup
Install dependencies： npm install
Start development server： npm run dev
Build for production：npm run build
Preview production build： npm run preview

🧹 Code Quality
Your project uses ESLint Flat Config with:

JavaScript recommended rules

React Hooks rules

React Refresh rules

Custom unused-variable rule for React components

Run lint:
npm run lint

🔮 Future Enhancements
Add TypeScript

Add global state (Zustand / Jotai)

Add UI design system (Antigravity / Tailwind)

Add API abstraction layer (src/lib/api.js)

Add unit tests (Vitest + RTL)

Add CI pipeline

