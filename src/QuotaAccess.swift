// Local credential adapter informed by CodexBar (MIT). See the bundled CodexBar-LICENSE.
import Foundation
import Security
import SQLite3
import CommonCrypto
import CryptoKit

struct AccessError: Error {
    let code: String
    let message: String
}

let interactive = CommandLine.arguments.contains("--interactive")
SecKeychainSetUserInteractionAllowed(interactive)
let userHome = FileManager.default.homeDirectoryForCurrentUser

func readRows(_ path: URL, query: String) throws -> [[String: Any]] {
    guard FileManager.default.fileExists(atPath: path.path) else {
        throw AccessError(code: "not_logged_in", message: "未找到本机登录记录")
    }
    var database: OpaquePointer?
    let status = sqlite3_open_v2(path.path, &database, SQLITE_OPEN_READONLY, nil)
    defer { sqlite3_close(database) }
    guard status == SQLITE_OK else {
        throw AccessError(code: "storage_unavailable", message: "暂时无法读取登录数据库，请稍后刷新")
    }
    sqlite3_busy_timeout(database, 1000)
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, query, -1, &statement, nil) == SQLITE_OK else {
        throw AccessError(code: "storage_changed", message: "登录数据库格式已变化")
    }
    defer { sqlite3_finalize(statement) }
    var rows: [[String: Any]] = []
    var step = sqlite3_step(statement)
    while step == SQLITE_ROW {
        var row: [String: Any] = [:]
        for index in 0..<sqlite3_column_count(statement) {
            let name = String(cString: sqlite3_column_name(statement, index))
            switch sqlite3_column_type(statement, index) {
            case SQLITE_TEXT:
                if let text = sqlite3_column_text(statement, index) {
                    row[name] = String(cString: text)
                }
            case SQLITE_BLOB:
                if let pointer = sqlite3_column_blob(statement, index) {
                    row[name] = Data(bytes: pointer, count: Int(sqlite3_column_bytes(statement, index)))
                }
            case SQLITE_INTEGER:
                row[name] = sqlite3_column_int64(statement, index)
            default: break
            }
        }
        rows.append(row)
        step = sqlite3_step(statement)
    }
    guard step == SQLITE_DONE else {
        throw AccessError(code: "storage_unavailable", message: "登录记录正在更新，请稍后刷新")
    }
    return rows
}

func password(service: String, account: String) throws -> Data {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecUseAuthenticationUI as String: interactive ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
        throw AccessError(code: "keychain_required", message: "点「授权读取」，允许访问 \(service) 后刷新")
    }
    return data
}

func decrypt(_ encrypted: Data, password: Data, host: String? = nil) throws -> String {
    guard encrypted.starts(with: Data("v10".utf8)), encrypted.count > 3 else {
        throw AccessError(code: "storage_changed", message: "暂不支持此版本的登录加密格式")
    }
    var key = [UInt8](repeating: 0, count: 16)
    let salt = Array("saltysalt".utf8)
    let keyResult = password.withUnsafeBytes { secret in
        salt.withUnsafeBufferPointer { saltBuffer in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                secret.bindMemory(to: Int8.self).baseAddress, password.count,
                saltBuffer.baseAddress, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),
                1003, &key, key.count)
        }
    }
    guard keyResult == kCCSuccess else {
        throw AccessError(code: "decrypt_failed", message: "无法读取登录状态，请重新授权")
    }
    let ciphertext = encrypted.dropFirst(3)
    var plaintext = [UInt8](repeating: 0, count: ciphertext.count + 16)
    let outputCapacity = plaintext.count
    var outputCount = 0
    let iv = [UInt8](repeating: 0x20, count: 16)
    let result = ciphertext.withUnsafeBytes { input in
        key.withUnsafeBufferPointer { keyBuffer in
            iv.withUnsafeBufferPointer { ivBuffer in
                CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES),
                        CCOptions(kCCOptionPKCS7Padding), keyBuffer.baseAddress, key.count,
                        ivBuffer.baseAddress, input.baseAddress, ciphertext.count,
                        &plaintext, outputCapacity, &outputCount)
            }
        }
    }
    guard result == kCCSuccess else {
        throw AccessError(code: "decrypt_failed", message: "登录加密信息不匹配，请重新登录对应应用")
    }
    var data = Data(plaintext.prefix(outputCount))
    if let host = host {
        let digest = Data(SHA256.hash(data: Data(host.utf8)))
        if data.starts(with: digest) { data.removeFirst(digest.count) }
    }
    guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else {
        throw AccessError(code: "decrypt_failed", message: "登录记录无法解码")
    }
    return text
}

func cursorSession() throws -> [String: Any] {
    let path = userHome.appendingPathComponent("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    let rows = try readRows(path, query: "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/cachedEmail','cursorAuth/stripeMembershipType')")
    var values: [String: String] = [:]
    for row in rows {
        guard let key = row["key"] as? String else { continue }
        if let text = row["value"] as? String { values[key] = text }
        else if let bytes = row["value"] as? Data {
            values[key] = String(data: bytes, encoding: .utf8) ?? String(data: bytes, encoding: .utf16LittleEndian)
        }
    }
    guard var token = values["cursorAuth/accessToken"], !token.isEmpty else {
        throw AccessError(code: "not_logged_in", message: "请先打开 Cursor 并登录")
    }
    let prefix = "cursor-safe-storage:v1:"
    if token.hasPrefix(prefix) {
        guard let data = Data(base64Encoded: String(token.dropFirst(prefix.count))) else {
            throw AccessError(code: "storage_changed", message: "Cursor 登录记录格式已变化")
        }
        var lastError: Error?
        for account in ["Cursor Key", "Cursor"] {
            do {
                token = try decrypt(data, password: password(service: "Cursor Safe Storage", account: account))
                lastError = nil
                break
            } catch { lastError = error }
        }
        if let error = lastError { throw error }
    }
    let parts = token.components(separatedBy: ".")
    guard parts.count == 3,
          let data = Data(base64Encoded: parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/").padding(toLength: ((parts[1].count + 3) / 4) * 4, withPad: "=", startingAt: 0)),
          let claims = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let subject = claims["sub"] as? String,
          let expiry = claims["exp"] as? Double, expiry > Date().timeIntervalSince1970 + 30
    else { throw AccessError(code: "not_logged_in", message: "Cursor 登录已过期，请打开 Cursor 后刷新") }
    let userID = subject.components(separatedBy: "|").last ?? subject
    return [
        "cookie": "WorkosCursorSessionToken=\(userID)%3A%3A\(token)",
        "email": values["cursorAuth/cachedEmail"] ?? "",
        "plan": values["cursorAuth/stripeMembershipType"] ?? ""
    ]
}

func geminiSession() throws -> [String: Any] {
    let browsers = [
        ("Chrome", "Google/Chrome", "Chrome Safe Storage", "Chrome"),
        ("Edge", "Microsoft Edge", "Microsoft Edge Safe Storage", "Microsoft Edge"),
        ("Brave", "BraveSoftware/Brave-Browser", "Brave Safe Storage", "Brave")
    ]
    var denied: AccessError?
    for (name, folder, service, account) in browsers {
        let root = userHome.appendingPathComponent("Library/Application Support/" + folder)
        let candidates = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        let profiles = candidates.filter { $0.lastPathComponent == "Default" || $0.lastPathComponent.hasPrefix("Profile ") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for profile in profiles {
            let stores = [profile.appendingPathComponent("Cookies"), profile.appendingPathComponent("Network/Cookies")]
            guard let store = stores.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else { continue }
            let rows = (try? readRows(store, query: """
                SELECT host_key, name, value, encrypted_value, expires_utc
                FROM cookies
                WHERE host_key IN ('.google.com','google.com','.gemini.google.com','gemini.google.com')
                ORDER BY length(host_key)
                """)) ?? []
            guard rows.contains(where: { ["SID", "__Secure-1PSID", "__Secure-3PSID"].contains($0["name"] as? String ?? "") }) else { continue }
            let key: Data
            do { key = try password(service: service, account: account) }
            catch let error as AccessError { denied = error; break }
            var cookies: [String: String] = [:]
            let now = (Date().timeIntervalSince1970 + 11644473600) * 1_000_000
            for row in rows {
                guard let cookieName = row["name"] as? String, let host = row["host_key"] as? String else { continue }
                if let expiry = row["expires_utc"] as? Int64, expiry > 0, Double(expiry) <= now { continue }
                var value = row["value"] as? String ?? ""
                if value.isEmpty, let encrypted = row["encrypted_value"] as? Data, !encrypted.isEmpty {
                    value = (try? decrypt(encrypted, password: key, host: host)) ?? ""
                }
                if !value.isEmpty, !value.contains(";"), !value.contains("\n") { cookies[cookieName] = value }
            }
            if cookies["__Secure-1PSID"] != nil || cookies["SID"] != nil {
                return ["cookie": cookies.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }.joined(separator: "; "),
                        "profile": "\(name) / \(profile.lastPathComponent)"]
            }
        }
    }
    if let denied = denied { throw denied }
    throw AccessError(code: "not_logged_in", message: "请先在 Chrome、Edge 或 Brave 登录 gemini.google.com")
}

do {
    let result: [String: Any]
    switch CommandLine.arguments.dropFirst().first {
    case "cursor": result = try cursorSession()
    case "gemini": result = try geminiSession()
    default: throw AccessError(code: "invalid_provider", message: "未指定服务")
    }
    let data = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(data)
} catch {
    let failure = error as? AccessError ?? AccessError(code: "access_failed", message: "读取失败，请稍后再试")
    let data = try JSONSerialization.data(withJSONObject: ["error": failure.code, "message": failure.message])
    FileHandle.standardOutput.write(data)
    exit(1)
}
