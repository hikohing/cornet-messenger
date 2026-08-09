import { useEffect, useState } from 'react'
import { AuthScreen } from './components/AuthScreen'
import { CallOverlay } from './components/CallOverlay'
import { ChatWindow } from './components/ChatWindow'
import { FoldersModal } from './components/FoldersModal'
import { InfoPanel } from './components/InfoPanel'
import { LeftRail, type RailView } from './components/LeftRail'
import { PrivacyPolicy } from './components/PrivacyPolicy'
import { ResetPasswordScreen } from './components/ResetPasswordScreen'
import { Sidebar } from './components/Sidebar'
import { SettingsPanel } from './components/SettingsPanel'
import { ToastHost } from './components/ToastHost'
import { VerifyEmailScreen } from './components/VerifyEmailScreen'
import { SpinnerIcon } from './components/icons'
import { useAuth } from './hooks/useAuth'
import { useChats } from './hooks/useChats'
import { useCrypto } from './hooks/useCrypto'
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
import { enablePush, listenForPushOpens, syncPushPreferences } from './native/push'
import { disableCallKit, enableCallKit, isCallKitAvailable, listenToCallKit } from './native/callkit'
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
  const [startChatUsername, clearStartChatUsername] = useLinkParam('startChat')
  // Уведомление, открытое при закрытом приложении, приносит чат в query —
  // postMessage отправлять было некому, окна ещё не существовало.
  const [pushChatId, clearPushChatId] = useLinkParam('openChat')
  const { preferences, updatePreferences, resetPreferences } = usePreferences()
  const {
    user,
    token,
    loading,
    error,
    login,
    register,
    logout,
    updateProfile,
    refreshUser,
    pendingTwoFactor,
    verifyTwoFactor,
    cancelTwoFactor,
  } = useAuth()
  const crypto = useCrypto(user?.id ?? null)
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
    createPoll,
    votePoll,
    closePoll,
    sendTyping,
    markRead,
    react,
    forwardMessage,
    pinMessage,
    searchInChat,
    startChat,
    startGroupChat,
    toggleChatPinned,
    folders,
    toggleArchived,
    toggleMuted,
    saveFolder,
    removeFolder,
    updateChatInfo,
    leaveChat,
    callSession,
  } = useChats(token, user?.id ?? null, preferences, updatePreferences)
  const { call } = callSession
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [showInfoPanel, setShowInfoPanel] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [showFolders, setShowFolders] = useState(false)
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

  // Ссылка-приглашение (?startChat=username): открывает/создаёт личный чат сразу
  // после входа, независимо от того, был ли человек уже залогинен в этом браузере.
  useEffect(() => {
    if (!user || !chatsLoaded || !startChatUsername) return
    let cancelled = false
    startChat(startChatUsername)
      .then((chat) => {
        if (cancelled) return
        setSelectedChatId(chat.id)
      })
      .catch(() => showToast('Не удалось начать чат: пользователь не найден'))
      .finally(() => {
        if (!cancelled) clearStartChatUsername()
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, chatsLoaded, startChatUsername])

  useEffect(() => {
    if (selectedChatId !== null && chatsLoaded && !chats.some((c) => c.id === selectedChatId)) {
      setSelectedChatId(null)
    }
  }, [chats, chatsLoaded, selectedChatId])

  // Пуш-устройство перерегистрируется при каждом запуске: APNs может выдать
  // новый device token, а подписка Web Push — протухнуть на стороне браузера.
  useEffect(() => {
    if (!user || !preferences.notifications) return
    void enablePush({
      preview: preferences.messagePreview,
      directEnabled: preferences.directNotifications,
      groupEnabled: preferences.groupNotifications,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, preferences.notifications])

  // Что показывать в уведомлении, решает сервер — значит, переключатели надо ему досылать.
  useEffect(() => {
    if (!user || !preferences.notifications) return
    void syncPushPreferences({
      preview: preferences.messagePreview,
      directEnabled: preferences.directNotifications,
      groupEnabled: preferences.groupNotifications,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.messagePreview, preferences.directNotifications, preferences.groupNotifications])

  // Звонки при закрытом приложении не зависят от настроек уведомлений о
  // сообщениях: токен PushKit выдаётся без спроса. Единственное, что их
  // выключает — режим «не беспокоить»: будить телефон, чтобы тут же сбросить
  // звонок, бессмысленно.
  useEffect(() => {
    if (!user || !isCallKitAvailable()) return
    if (preferences.doNotDisturbCalls) {
      void disableCallKit()
      return
    }
    void enableCallKit()
  }, [user, preferences.doNotDisturbCalls])

  useEffect(() => {
    if (!user || !isCallKitAvailable()) return
    return listenToCallKit({
      // Пуш разбудил приложение — приглашение с оффером ждёт нас на сервере.
      onIncoming: (push) => callSession.claimIncomingCall(push.callId),
      onAnswer: (callId) => callSession.acceptFromCallKit(callId),
      onEnd: (callId) => callSession.endFromCallKit(callId),
      onMute: (callId, muted) => callSession.muteFromCallKit(callId, muted),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Тап по уведомлению открывает чат: из service worker — сообщением, из
  // нативного слоя — событием, оба приходят сюда одним `push:open-chat`.
  useEffect(() => {
    const openChat = (event: Event) => {
      const chatId = (event as CustomEvent<{ chatId: number }>).detail?.chatId
      if (chatId) setSelectedChatId(chatId)
    }
    document.addEventListener('push:open-chat', openChat)
    const stopListening = listenForPushOpens()
    return () => {
      document.removeEventListener('push:open-chat', openChat)
      stopListening()
    }
  }, [])

  useEffect(() => {
    if (!user || !chatsLoaded || !pushChatId) return
    const chatId = Number(pushChatId)
    if (chats.some((chat) => chat.id === chatId)) setSelectedChatId(chatId)
    clearPushChatId()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, chatsLoaded, pushChatId])

  // Публичный адрес политики: ревьюер App Store и любой желающий открывают её
  // по ссылке, без входа в аккаунт. Поэтому проверка идёт до всего остального.
  if (window.location.pathname === '/privacy') {
    return <PrivacyPolicy />
  }

  if (showPrivacy) {
    return <PrivacyPolicy onClose={() => setShowPrivacy(false)} />
  }

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
        <AuthScreen
          error={error}
          onLogin={login}
          onRegister={register}
          pendingTwoFactor={pendingTwoFactor}
          onVerifyTwoFactor={verifyTwoFactor}
          onCancelTwoFactor={cancelTwoFactor}
          onOpenPrivacy={() => setShowPrivacy(true)}
        />
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
        folders={folders}
        onToggleArchived={toggleArchived}
        onToggleMuted={toggleMuted}
        onManageFolders={() => setShowFolders(true)}
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
        onEdit={(messageId, text) => editMessage(messageId, text, selectedChat?.id)}
        onCreatePoll={(poll) => selectedChat && createPoll(selectedChat.id, poll)}
        onVotePoll={votePoll}
        onClosePoll={closePoll}
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
      {showFolders && (
        <FoldersModal
          folders={folders}
          chats={chats}
          onSave={saveFolder}
          onDelete={removeFolder}
          onClose={() => setShowFolders(false)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          user={user}
          onUpdateProfile={updateProfile}
          onChangePassword={(oldPassword, newPassword) => apiChangePassword(oldPassword, newPassword)}
          onRequestEmailVerification={(email) => apiRequestEmailVerification(email)}
          onRemoveEmail={() => apiRemoveEmail().then(() => refreshUser())}
          onRefreshUser={refreshUser}
          preferences={preferences}
          onUpdatePreferences={updatePreferences}
          onResetPreferences={resetPreferences}
          onAccountDeleted={() => {
            setShowSettings(false)
            // Приватные ключи переживают обычный выход намеренно — без них не
            // прочитать собственную историю после повторного входа. Но у
            // удалённого аккаунта читать уже нечего, и оставлять их на
            // устройстве значит не доделать ровно ту работу, ради которой
            // кнопка и нужна.
            crypto.reset()
            logout()
            showToast('Аккаунт удалён')
          }}
          onOpenPrivacy={() => {
            setShowSettings(false)
            setShowPrivacy(true)
          }}
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
