import { useEffect, useState } from 'react'
import { AuthScreen } from './components/AuthScreen'
import { CallOverlay } from './components/CallOverlay'
import { ChatWindow } from './components/ChatWindow'
import { InfoPanel } from './components/InfoPanel'
import { LeftRail, type RailView } from './components/LeftRail'
import { ResetPasswordScreen } from './components/ResetPasswordScreen'
import { Sidebar } from './components/Sidebar'
import { SettingsPanel } from './components/SettingsPanel'
import { ToastHost } from './components/ToastHost'
import { VerifyEmailScreen } from './components/VerifyEmailScreen'
import { SpinnerIcon } from './components/icons'
import { useAuth } from './hooks/useAuth'
import { useChats } from './hooks/useChats'
import { usePreferences } from './hooks/usePreferences'
import { showToast } from './hooks/useToast'
import {
  blockUser as apiBlockUser,
  changePassword as apiChangePassword,
  getBlockedUsers,
  removeEmail as apiRemoveEmail,
  requestEmailVerification as apiRequestEmailVerification,
  unblockUser as apiUnblockUser,
} from './api/client'
import './App.css'

/** Ссылки из писем ведут сюда через query-параметры — работает независимо от того, залогинен ли человек в этом браузере. */
function useLinkParam(name: string) {
  const [value, setValue] = useState(() => new URLSearchParams(window.location.search).get(name))
  function clear() {
    const url = new URL(window.location.href)
    url.searchParams.delete(name)
    window.history.replaceState(null, '', url.pathname + url.search)
    setValue(null)
  }
  return [value, clear] as const
}

function App() {
  const [resetToken, clearResetToken] = useLinkParam('resetToken')
  const [verifyEmailToken, clearVerifyEmailToken] = useLinkParam('verifyEmail')
  const { preferences, updatePreferences, resetPreferences } = usePreferences()
  const { user, token, loading, error, login, register, logout, updateProfile, refreshUser } = useAuth()
  const {
    chats,
    chatsLoaded,
    connectionStatus,
    messagesForChat,
    isLoadingMessages,
    typingUsersForChat,
    setActiveChat,
    loadMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    sendTyping,
    markRead,
    react,
    forwardMessage,
    pinMessage,
    searchInChat,
    startChat,
    startGroupChat,
    toggleChatPinned,
    updateChatInfo,
    leaveChat,
    callSession,
  } = useChats(token, user?.id ?? null, preferences, updatePreferences)
  const { call } = callSession
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showInfoPanel, setShowInfoPanel] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [railView, setRailView] = useState<RailView>('all')
  const [blockedUserIds, setBlockedUserIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!user) {
      setBlockedUserIds(new Set())
      return
    }
    getBlockedUsers()
      .then((res) => setBlockedUserIds(new Set(res.users.map((u) => u.id))))
      .catch(() => undefined)
  }, [user])

  useEffect(() => {
    if (selectedChatId !== null) loadMessages(selectedChatId)
    setActiveChat(selectedChatId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChatId])

  useEffect(() => {
    if (selectedChatId !== null && chatsLoaded && !chats.some((c) => c.id === selectedChatId)) {
      setSelectedChatId(null)
    }
  }, [chats, chatsLoaded, selectedChatId])

  if (resetToken) {
    return <ResetPasswordScreen token={resetToken} onDone={clearResetToken} />
  }

  if (verifyEmailToken) {
    return <VerifyEmailScreen token={verifyEmailToken} onDone={clearVerifyEmailToken} />
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <SpinnerIcon width={26} height={26} />
      </div>
    )
  }

  if (!user) {
    return (
      <>
        <AuthScreen error={error} onLogin={login} onRegister={register} />
        <ToastHost />
      </>
    )
  }

  const selectedChat = chats.find((c) => c.id === selectedChatId)

  function selectChat(chatId: number) {
    setSelectedChatId(chatId)
    setShowInfoPanel(false)
  }

  function selectRailView(view: RailView) {
    setRailView(view)
    if (view === 'saved') {
      const saved = chats.find((c) => c.type === 'saved')
      if (saved) selectChat(saved.id)
    }
  }

  return (
    <div
      className={`app-shell${selectedChatId !== null ? ' chat-open' : ''}${showInfoPanel ? ' info-open' : ''}`}
    >
      <LeftRail
        activeView={railView}
        createOpen={showNewChat}
        onSelectView={selectRailView}
        onCreateNew={() => setShowNewChat((v) => !v)}
      />
      <Sidebar
        chats={chats}
        chatsLoading={!chatsLoaded}
        currentUser={user}
        connectionStatus={connectionStatus}
        selectedChatId={selectedChatId}
        railView={railView}
        showNewChat={showNewChat}
        onCloseNewChat={() => setShowNewChat(false)}
        onSelectChat={selectChat}
        onStartChat={startChat}
        onStartGroupChat={startGroupChat}
        onOpenSettings={() => setShowSettings(true)}
        onLogout={logout}
        onTogglePinned={toggleChatPinned}
      />
      <ChatWindow
        chat={selectedChat}
        chats={chats}
        messages={selectedChat ? messagesForChat(selectedChat.id) : []}
        currentUserId={user.id}
        typingUserIds={selectedChat ? typingUsersForChat(selectedChat.id) : []}
        isLoadingMessages={selectedChat ? isLoadingMessages(selectedChat.id) : false}
        connectionStatus={connectionStatus}
        enterToSend={preferences.enterToSend}
        sendTypingEnabled={preferences.sendTyping}
        sendReadReceipts={preferences.sendReadReceipts}
        saveDrafts={preferences.saveDrafts}
        onBack={() => setSelectedChatId(null)}
        onSend={(text, attachment, replyToId) =>
          selectedChat ? sendMessage(selectedChat.id, text, attachment, replyToId) : false
        }
        onEdit={editMessage}
        onDelete={deleteMessage}
        onTyping={sendTyping}
        onMarkRead={markRead}
        onReact={react}
        onForward={forwardMessage}
        onTogglePin={pinMessage}
        onSearch={searchInChat}
        showInfoPanel={showInfoPanel}
        onToggleInfoPanel={() => setShowInfoPanel((v) => !v)}
        onStartCall={(video) => {
          const other = selectedChat?.members.find((m) => m.id !== user.id)
          if (!selectedChat || !other) return
          if (!other.online) {
            showToast('Собеседник не в сети')
            return
          }
          void callSession.startCall(selectedChat.id, other, video)
        }}
      />
      {showInfoPanel && selectedChat && (
        <InfoPanel
          chat={selectedChat}
          currentUserId={user.id}
          blockedUserIds={blockedUserIds}
          onBlockUser={async (userId) => {
            await apiBlockUser(userId)
            setBlockedUserIds((prev) => new Set(prev).add(userId))
          }}
          onUnblockUser={async (userId) => {
            await apiUnblockUser(userId)
            setBlockedUserIds((prev) => {
              const next = new Set(prev)
              next.delete(userId)
              return next
            })
          }}
          onClose={() => setShowInfoPanel(false)}
          onScrollToPinned={() => {
            setShowInfoPanel(false)
            const id = selectedChat.pinnedMessage?.id
            if (id === undefined) return
            setTimeout(() => {
              document.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }, 240)
          }}
          onTogglePin={(messageId) => pinMessage(selectedChat.id, messageId)}
          onUpdateChatInfo={(patch) => updateChatInfo(selectedChat.id, patch).then(() => undefined)}
          onMessageUser={async (username) => {
            const chat = await startChat(username)
            selectChat(chat.id)
          }}
          onLeaveGroup={async () => {
            await leaveChat(selectedChat.id)
            setShowInfoPanel(false)
          }}
        />
      )}
      {showSettings && (
        <SettingsPanel
          user={user}
          onUpdateProfile={updateProfile}
          onChangePassword={(oldPassword, newPassword) => apiChangePassword(oldPassword, newPassword)}
          onRequestEmailVerification={(email) => apiRequestEmailVerification(email)}
          onRemoveEmail={() => apiRemoveEmail().then(() => refreshUser())}
          preferences={preferences}
          onUpdatePreferences={updatePreferences}
          onResetPreferences={resetPreferences}
          onClose={() => setShowSettings(false)}
        />
      )}
      {call && (
        <CallOverlay
          call={call}
          preferences={preferences}
          onAccept={callSession.acceptCall}
          onReject={callSession.rejectCall}
          onHangUp={callSession.hangUp}
          onToggleMute={callSession.toggleMute}
          onToggleCamera={callSession.toggleCamera}
          onToggleScreenShare={callSession.toggleScreenShare}
          onSelectDevice={callSession.switchDevice}
          onMinimize={callSession.setMinimized}
          getStats={callSession.getCallStats}
        />
      )}
      <ToastHost />
    </div>
  )
}

export default App
