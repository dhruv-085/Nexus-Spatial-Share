import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      copied: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('[Nexus ErrorBoundary] Uncaught exception in React component tree:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handlePurgeAndReset = () => {
    try {
      sessionStorage.clear();
      // Clear specific temporary transfer keys from localStorage while preserving client id
      const keysToKeep = new Set(['nexus_client_id']);
      const allKeys = Object.keys(localStorage);
      for (const key of allKeys) {
        if (!keysToKeep.has(key) && key.startsWith('nexus_')) {
          localStorage.removeItem(key);
        }
      }
    } catch (_) {}
    window.location.href = '/';
  };

  handleToggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  handleCopyDiagnostics = () => {
    const { error, errorInfo } = this.state;
    const diag = `NEXUS RUNTIME EXCEPTION DIAGNOSTICS
Time: ${new Date().toISOString()}
UserAgent: ${navigator.userAgent}
URL: ${window.location.href}

Error:
${error?.name}: ${error?.message}
${error?.stack || 'No stack trace available'}

Component Stack:
${errorInfo?.componentStack || 'No component stack available'}`;

    navigator.clipboard.writeText(diag).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2500);
    }).catch(() => {});
  };

  render() {
    if (this.state.hasError) {
      const { error, errorInfo, showDetails, copied } = this.state;

      return (
        <div
          style={{
            minHeight: '100vh',
            width: '100%',
            backgroundColor: '#08080a',
            color: '#f8fafc',
            fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            position: 'relative',
            boxSizing: 'border-box',
            overflowY: 'auto',
          }}
        >
          {/* Ambient radial glow */}
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '500px',
              height: '500px',
              background: 'radial-gradient(circle, rgba(239, 68, 68, 0.12) 0%, rgba(139, 92, 246, 0.08) 45%, transparent 70%)',
              filter: 'blur(70px)',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />

          <div
            style={{
              position: 'relative',
              zIndex: 1,
              maxWidth: '560px',
              width: '100%',
              backgroundColor: 'rgba(18, 18, 24, 0.85)',
              border: '1px solid rgba(255, 255, 255, 0.09)',
              borderRadius: '24px',
              padding: '40px 32px',
              backdropFilter: 'blur(30px)',
              WebkitBackdropFilter: 'blur(30px)',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
              textAlign: 'center',
            }}
          >
            {/* Warning pulse icon badge */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '64px',
                height: '64px',
                borderRadius: '20px',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.28)',
                color: '#f87171',
                marginBottom: '20px',
                boxShadow: '0 0 24px rgba(239, 68, 68, 0.2)',
              }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>

            <div
              style={{
                display: 'inline-block',
                padding: '4px 12px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '999px',
                fontSize: '11px',
                fontWeight: 600,
                fontFamily: "'JetBrains Mono', monospace",
                color: '#fca5a5',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                marginBottom: '14px',
              }}
            >
              System Safeguard Active
            </div>

            <h1
              style={{
                fontSize: '24px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: '#ffffff',
                marginBottom: '10px',
              }}
            >
              Nexus Core Interrupted
            </h1>

            <p
              style={{
                fontSize: '14px',
                lineHeight: 1.6,
                color: '#94a3b8',
                marginBottom: '28px',
              }}
            >
              A runtime exception occurred in the spatial interface. Your session state can be safely restored.
            </p>

            {/* Action buttons */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                marginBottom: '24px',
              }}
            >
              <button
                id="btn-error-reboot"
                onClick={this.handleReload}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '14px 20px',
                  background: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 600,
                  borderRadius: '12px',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 4px 16px rgba(6, 182, 212, 0.3)',
                  transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                }}
                onMouseOver={(e) => (e.currentTarget.style.transform = 'translateY(-1px)')}
                onMouseOut={(e) => (e.currentTarget.style.transform = 'translateY(0)')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
                Reboot System
              </button>

              <button
                id="btn-error-purge"
                onClick={this.handlePurgeAndReset}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '12px 20px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: '#cbd5e1',
                  fontSize: '13px',
                  fontWeight: 500,
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  cursor: 'pointer',
                  transition: 'background-color 0.15s ease',
                }}
                onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)')}
                onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                </svg>
                Purge Session & Reconnect
              </button>
            </div>

            {/* Diagnostic disclosure button */}
            <div style={{ textAlign: 'left', marginTop: '16px' }}>
              <button
                onClick={this.handleToggleDetails}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 0',
                }}
              >
                <span>{showDetails ? '▼ Hide Diagnostic Telemetry' : '▶ Show Diagnostic Telemetry'}</span>
              </button>

              {showDetails && (
                <div
                  style={{
                    marginTop: '12px',
                    padding: '14px',
                    borderRadius: '12px',
                    background: 'rgba(0, 0, 0, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.07)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '11px',
                    color: '#e2e8f0',
                    textAlign: 'left',
                    maxHeight: '220px',
                    overflowY: 'auto',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '8px',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                      paddingBottom: '6px',
                    }}
                  >
                    <span style={{ color: '#f87171', fontWeight: 600 }}>
                      {error?.name || 'Error'}: {error?.message || 'Unknown Exception'}
                    </span>
                    <button
                      onClick={this.handleCopyDiagnostics}
                      style={{
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        color: '#94a3b8',
                        borderRadius: '6px',
                        padding: '3px 8px',
                        fontSize: '10px',
                        cursor: 'pointer',
                      }}
                    >
                      {copied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#94a3b8' }}>
                    {error?.stack}
                    {errorInfo?.componentStack}
                  </pre>
                </div>
              )}
            </div>

            <div
              style={{
                marginTop: '28px',
                fontSize: '11px',
                color: '#475569',
                fontWeight: 500,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
              }}
            >
              Nexus Spatial Share Fault Isolation Layer
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
