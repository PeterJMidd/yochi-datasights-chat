"use client"

import { signIn } from "next-auth/react"

export default function LoginPage() {
  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          YoChi <span>DataSights</span>
        </div>
        <p className="login-subtitle">
          Sign in to access your franchise data explorer
        </p>
        <button
          className="login-btn"
          onClick={() => signIn("microsoft-entra-id", { callbackUrl: "/" })}
        >
          <svg viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="9" height="9" fill="#F25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
            <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
          </svg>
          Sign in with Microsoft
        </button>
      </div>
    </div>
  )
}
