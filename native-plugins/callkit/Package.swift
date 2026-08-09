// swift-tools-version: 5.9
import PackageDescription

// Имя продукта не произвольное: Capacitor выводит его из имени npm-пакета
// (`cornet-callkit` → `CornetCallkit`) и подключает к приложению именно под ним.
// Разойдётся регистр — сборка упадёт на разрешении зависимостей.
//
// Имя цели совпадает с продуктом сознательно: тогда Swift-модуль называется так
// же, и в AppDelegate пишется тот же `import CornetCallkit`.
let package = Package(
    name: "CornetCallkit",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CornetCallkit",
            targets: ["CornetCallkit"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "CornetCallkit",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CornetCallkit")
    ]
)
