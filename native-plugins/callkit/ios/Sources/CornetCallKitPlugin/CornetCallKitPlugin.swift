import Capacitor
import Foundation

/// Мост между CallCenter и JS. Сам ничего не решает: вся работа с CallKit и
/// PushKit живёт в CallCenter, который стартует из AppDelegate раньше, чем
/// появляется WebView.
@objc(CornetCallKitPlugin)
public class CornetCallKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CornetCallKitPlugin"
    public let jsName = "CornetCallKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportOutgoingCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportCallEnded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCall", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        CallCenter.shared.configure()
        CallCenter.shared.eventSink = { [weak self] name, data in
            // retainUntilConsumed: событие может случиться раньше, чем JS успеет
            // подписаться — приложение, разбуженное пушем, поднимает WebView уже
            // после того, как звонок показан.
            self?.notifyListeners(name, data: data, retainUntilConsumed: true)
        }
    }

    @objc func register(_ call: CAPPluginCall) {
        CallCenter.shared.configure()
        // Токен мог прийти до подписки на события — отдаём его синхронно.
        call.resolve(["token": CallCenter.shared.currentVoipToken() ?? ""])
    }

    @objc func reportOutgoingCall(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else {
            call.reject("callId обязателен")
            return
        }
        CallCenter.shared.reportOutgoingCall(
            callId: callId,
            handle: call.getString("handle") ?? "",
            video: call.getBool("video") ?? false
        )
        call.resolve()
    }

    @objc func reportConnected(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else {
            call.reject("callId обязателен")
            return
        }
        CallCenter.shared.reportConnected(callId: callId)
        call.resolve()
    }

    @objc func reportCallEnded(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else {
            call.reject("callId обязателен")
            return
        }
        CallCenter.shared.reportCallEnded(callId: callId, reason: call.getString("reason") ?? "hangup")
        call.resolve()
    }

    @objc func endCall(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else {
            call.reject("callId обязателен")
            return
        }
        CallCenter.shared.endCall(callId: callId)
        call.resolve()
    }
}
