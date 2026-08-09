import AVFoundation
import CallKit
import Foundation
import PushKit

/// Единственный на приложение владелец CallKit и PushKit.
///
/// Живёт отдельно от Capacitor-плагина сознательно. VoIP-пуш может разбудить
/// приложение, когда WebView ещё не создан, а iOS требует показать входящий
/// звонок немедленно — до того, как отработает completion пуша, иначе система
/// убивает процесс и после нескольких нарушений перестаёт доставлять VoIP-пуши
/// вовсе. Поэтому регистрация делается из AppDelegate, не дожидаясь моста, а
/// события, случившиеся до появления JS, копятся в очереди и уезжают наверх,
/// как только плагин подключится.
public final class CallCenter: NSObject {
    public static let shared = CallCenter()

    public typealias EventSink = (String, [String: Any]) -> Void

    private var provider: CXProvider?
    private let callController = CXCallController()
    private var voipRegistry: PKPushRegistry?
    private var queuedEvents: [(String, [String: Any])] = []
    private var voipToken: String?

    /// Плагин подставляет сюда мост в JS. До этого момента события копятся.
    public var eventSink: EventSink? {
        didSet {
            guard eventSink != nil else { return }
            let pending = queuedEvents
            queuedEvents = []
            for (name, data) in pending { eventSink?(name, data) }
        }
    }

    /// Вызывать из `application(_:didFinishLaunchingWithOptions:)`.
    public func configure() {
        guard provider == nil else { return }

        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        // .generic, а не .phoneNumber: у нас имена пользователей, а не телефоны —
        // иначе система предложит «перезвонить» на несуществующий номер.
        configuration.supportedHandleTypes = [.generic]

        let provider = CXProvider(configuration: configuration)
        provider.setDelegate(self, queue: nil)
        self.provider = provider

        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
    }

    /// Токен мог прийти до того, как JS успел подписаться на события.
    public func currentVoipToken() -> String? {
        voipToken
    }

    // MARK: - Управление звонком со стороны приложения

    /// Исходящий звонок: без этого он не попадёт в системный журнал вызовов, а
    /// CallKit не будет знать, что линия занята.
    public func reportOutgoingCall(callId: String, handle: String, video: Bool) {
        guard let uuid = UUID(uuidString: callId) else { return }
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: handle))
        action.isVideo = video
        // О начале дозвона системе сообщает обработчик CXStartCallAction ниже —
        // он выполняется в ответ на эту транзакцию.
        callController.request(CXTransaction(action: action)) { _ in }
    }

    /// Соединение установлено — CallKit запускает счётчик длительности.
    public func reportConnected(callId: String) {
        guard let uuid = UUID(uuidString: callId) else { return }
        provider?.reportOutgoingCall(with: uuid, connectedAt: nil)
    }

    /// Звонок завершился не по кнопке в системном интерфейсе: собеседник положил
    /// трубку, не ответил, или соединение развалилось.
    public func reportCallEnded(callId: String, reason: String) {
        guard let uuid = UUID(uuidString: callId) else { return }
        let endReason: CXCallEndedReason
        switch reason {
        case "reject", "declined": endReason = .declinedElsewhere
        case "no_answer", "timeout": endReason = .unanswered
        case "busy": endReason = .failed
        case "unavailable", "failed": endReason = .failed
        case "answered_elsewhere": endReason = .answeredElsewhere
        default: endReason = .remoteEnded
        }
        provider?.reportCall(with: uuid, endedAt: nil, reason: endReason)
    }

    /// Пользователь положил трубку в интерфейсе самого приложения — сообщаем об
    /// этом CallKit транзакцией, чтобы системный экран закрылся.
    public func endCall(callId: String) {
        guard let uuid = UUID(uuidString: callId) else { return }
        let action = CXEndCallAction(call: uuid)
        callController.request(CXTransaction(action: action)) { _ in }
    }

    // MARK: - Внутреннее

    private func emit(_ name: String, _ data: [String: Any]) {
        if let sink = eventSink {
            sink(name, data)
        } else {
            queuedEvents.append((name, data))
        }
    }

    /// Категорию задаём заранее, но сессию не активируем: её активирует сам
    /// CallKit и отдаёт нам в `provider(_:didActivate:)`.
    private func prepareAudioSession(video: Bool) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord,
            mode: video ? .videoChat : .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP]
        )
    }
}

// MARK: - PushKit

extension CallCenter: PKPushRegistryDelegate {
    public func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        voipToken = token
        emit("registration", ["token": token])
    }

    public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        voipToken = nil
        emit("registrationInvalidated", [:])
    }

    public func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP, let provider = provider else {
            completion()
            return
        }

        let data = payload.dictionaryPayload
        let callId = data["callId"] as? String ?? ""
        let callerName = data["callerName"] as? String ?? "Входящий звонок"
        let video = data["video"] as? Bool ?? false

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = video
        update.supportsDTMF = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false

        // Показать звонок обязаны в любом случае — даже если полезная нагрузка
        // испорчена. Иначе iOS завершит процесс. Непригодный звонок сразу же
        // закрываем как сбойный.
        guard let uuid = UUID(uuidString: callId) else {
            let placeholder = UUID()
            provider.reportNewIncomingCall(with: placeholder, update: update) { _ in
                provider.reportCall(with: placeholder, endedAt: nil, reason: .failed)
                completion()
            }
            return
        }

        prepareAudioSession(video: video)
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error = error {
                // Систему звонок не устроил (например, включён «Не беспокоить» с
                // блокировкой) — приложению делать нечего.
                self?.emit("incomingCallFailed", ["callId": callId, "message": error.localizedDescription])
                completion()
                return
            }
            self?.emit("incomingCall", [
                "callId": callId,
                "chatId": data["chatId"] as? Int ?? 0,
                "callerId": data["callerId"] as? Int ?? 0,
                "callerName": callerName,
                "video": video
            ])
            completion()
        }
    }
}

// MARK: - CallKit

extension CallCenter: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        // Система сбросила все звонки (например, при сбое) — приложение должно
        // погасить свои.
        emit("resetCalls", [:])
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        emit("answerCall", ["callId": action.callUUID.uuidString.lowercased()])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        emit("endCall", ["callId": action.callUUID.uuidString.lowercased()])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        emit("muteChanged", ["callId": action.callUUID.uuidString.lowercased(), "muted": action.isMuted])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // Звук в звонке ведёт WebRTC внутри WKWebView, своей аудиоединицей мы не
        // управляем. Сообщаем наверх, чтобы приложение могло переподключить
        // дорожки, если система забрала сессию себе.
        emit("audioSessionActivated", [:])
    }

    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        emit("audioSessionDeactivated", [:])
    }
}
