const browserAPI = typeof chrome !== "undefined" ? chrome : browser;

const defaultConfig = {
	isActive: true,
	prefetchLevel: "medium",
	batterySaving: false,
	dataSaver: false,
	whitelist: [],
	blacklist: [],
};

// 現在の設定とリセット用の保存設定
let currentConfig = { ...defaultConfig };
let originalConfig = null;

document.addEventListener("DOMContentLoaded", async () => {
	localizeUI();
	await loadSettings();
	await loadStatistics();
	setupEventListeners();
});

function localizeUI() {
	const elements = document.querySelectorAll("[data-i18n]");

	elements.forEach((element) => {
		const messageId = element.getAttribute("data-i18n");
		const args = element.getAttribute("data-i18n-args");

		let message;
		if (args) {
			message = browserAPI.i18n.getMessage(messageId, args.split(","));
		} else {
			message = browserAPI.i18n.getMessage(messageId);
		}

		if (message) {
			element.textContent = message;
		}
	});
}

async function loadSettings() {
	try {
		const result = await browserAPI.storage.local.get("config");
		if (result.config) {
			currentConfig = { ...defaultConfig, ...result.config };
		}

		// 設定値をUIに反映
		document.getElementById("prefetch-level").value =
			currentConfig.prefetchLevel;
		document.getElementById("battery-saving").checked =
			currentConfig.batterySaving;
		document.getElementById("data-saver").checked = currentConfig.dataSaver;

		// ドメインリストの反映
		document.getElementById("whitelist").value =
			currentConfig.whitelist.join(", ");
		document.getElementById("blacklist").value =
			currentConfig.blacklist.join(", ");

		// 元の設定を保存
		originalConfig = JSON.parse(JSON.stringify(currentConfig));
	} catch (error) {
		console.error("設定の読み込み中にエラーが発生しました:", error);
		showStatusMessage("設定の読み込みに失敗しました", "error");
	}
}

async function loadStatistics() {
	try {
		const stats = await browserAPI.storage.local.get({
			stats: {
				totalTimeSaved: 0,
				prefetchedPages: 0,
				successfulPrefetches: 0,
			},
		});

		// 統計情報をUIに反映
		const totalTimeFormatted = formatTime(stats.stats.totalTimeSaved || 0);
		document.getElementById("total-time-saved").textContent =
			totalTimeFormatted;
		document.getElementById("prefetched-pages").textContent =
			stats.stats.prefetchedPages || 0;
		document.getElementById("successful-prefetches").textContent =
			stats.stats.successfulPrefetches || 0;

		// ヒット率の計算
		const hitRate =
			stats.stats.prefetchedPages > 0
				? Math.round(
						(stats.stats.successfulPrefetches /
							stats.stats.prefetchedPages) *
							100
				  )
				: 0;
		document.getElementById("hit-rate").textContent = `${hitRate}%`;
	} catch (error) {
		console.error("統計情報の読み込み中にエラーが発生しました:", error);
	}
}

function formatTime(milliseconds) {
	const seconds = Math.floor(milliseconds / 1000);

	if (seconds < 60) {
		return `${seconds}秒`;
	}

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;

	if (minutes < 60) {
		return `${minutes}分${remainingSeconds}秒`;
	}

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;

	return `${hours}時間${remainingMinutes}分${remainingSeconds}秒`;
}

function setupEventListeners() {
	// 保存ボタン
	document
		.getElementById("save-settings")
		.addEventListener("click", saveSettings);

	// 統計情報のリセット
	document
		.getElementById("reset-stats")
		.addEventListener("click", resetStatistics);

	// データのエクスポート
	document
		.getElementById("export-data")
		.addEventListener("click", exportData);

	// データのインポート（ファイル選択）
	document.getElementById("import-data").addEventListener("click", () => {
		document.getElementById("import-file").click();
	});

	// データのインポート（ファイル読み込み）
	document
		.getElementById("import-file")
		.addEventListener("change", importData);

	// すべてのデータのリセット
	document
		.getElementById("reset-all")
		.addEventListener("click", resetAllData);
}

async function saveSettings() {
	try {
		// UIから設定を取得
		const config = {
			isActive: currentConfig.isActive, // アクティブ状態は変更しない
			prefetchLevel: document.getElementById("prefetch-level").value,
			batterySaving: document.getElementById("battery-saving").checked,
			dataSaver: document.getElementById("data-saver").checked,
			whitelist: parseUrlList(document.getElementById("whitelist").value),
			blacklist: parseUrlList(document.getElementById("blacklist").value),
		};
		await browserAPI.storage.local.set({ config });

		// 設定変更を通知
		browserAPI.runtime.sendMessage({ action: "configUpdated", config });
		showStatusMessage("設定が保存されました", "success");

		// 現在の設定を更新
		currentConfig = config;
		originalConfig = JSON.parse(JSON.stringify(config));
	} catch (error) {
		console.error("設定の保存中にエラーが発生しました:", error);
		showStatusMessage("設定の保存に失敗しました", "error");
	}
}

// URLリストの解析
function parseUrlList(text) {
	if (!text.trim()) {
		return [];
	}

	return text
		.split(",")
		.map((url) => url.trim())
		.filter((url) => url.length > 0);
}

async function resetStatistics() {
	if (!confirm("統計情報をリセットしますか？この操作は元に戻せません。")) {
		return;
	}

	try {
		const stats = {
			totalTimeSaved: 0,
			prefetchedPages: 0,
			successfulPrefetches: 0,
			visitedUrls: JSON.stringify([]),
			navigationPatterns: JSON.stringify([]),
		};

		await browserAPI.storage.local.set({ stats });

		// 統計情報の表示を更新
		document.getElementById("total-time-saved").textContent = "0秒";
		document.getElementById("prefetched-pages").textContent = "0";
		document.getElementById("successful-prefetches").textContent = "0";
		document.getElementById("hit-rate").textContent = "0%";

		showStatusMessage("統計情報がリセットされました", "success");
	} catch (error) {
		console.error("統計情報のリセット中にエラーが発生しました:", error);
		showStatusMessage("統計情報のリセットに失敗しました", "error");
	}
}

function exportData() {
	try {
		browserAPI.storage.local.get(null, (items) => {
			// データをJSON形式に変換
			const jsonData = JSON.stringify(items, null, 2);

			// データをダウンロードするためのリンクを作成
			const blob = new Blob([jsonData], { type: "application/json" });
			const url = URL.createObjectURL(blob);

			// ダウンロードリンクを作成して自動クリック
			const downloadLink = document.createElement("a");
			downloadLink.href = url;
			downloadLink.download = `precache-predictor-data-${new Date()
				.toISOString()
				.slice(0, 10)}.json`;
			downloadLink.click();

			setTimeout(() => {
				URL.revokeObjectURL(url);
			}, 100);

			showStatusMessage("データがエクスポートされました", "success");
		});
	} catch (error) {
		console.error("データのエクスポート中にエラーが発生しました:", error);
		showStatusMessage("データのエクスポートに失敗しました", "error");
	}
}

function importData(event) {
	const file = event.target.files[0];
	if (!file) {
		return;
	}

	const reader = new FileReader();
	reader.onload = async (e) => {
		try {
			const importedData = JSON.parse(e.target.result);

			// 確認ダイアログを表示
			if (
				!confirm(
					"インポートしたデータで現在の設定を上書きしますか？この操作は元に戻せません。"
				)
			) {
				return;
			}

			// データを保存
			await browserAPI.storage.local.clear();
			await browserAPI.storage.local.set(importedData);

			// 設定と統計情報を再読み込み
			await loadSettings();
			await loadStatistics();

			showStatusMessage("データがインポートされました", "success");
		} catch (error) {
			console.error("データのインポート中にエラーが発生しました:", error);
			showStatusMessage("データのインポートに失敗しました", "error");
		}
	};

	reader.readAsText(file);
	event.target.value = "";
}

async function resetAllData() {
	if (
		!confirm(
			"すべての設定と統計情報をリセットしますか？この操作は元に戻せません。"
		)
	) {
		return;
	}

	try {
		await browserAPI.storage.local.clear();

		// デフォルト設定を保存
		await browserAPI.storage.local.set({
			config: defaultConfig,
			stats: {
				totalTimeSaved: 0,
				prefetchedPages: 0,
				successfulPrefetches: 0,
				visitedUrls: JSON.stringify([]),
				navigationPatterns: JSON.stringify([]),
			},
		});

		await loadSettings();
		await loadStatistics();

		showStatusMessage("すべてのデータがリセットされました", "success");
	} catch (error) {
		console.error("データのリセット中にエラーが発生しました:", error);
		showStatusMessage("データのリセットに失敗しました", "error");
	}
}

function showStatusMessage(message, type) {
	const statusElement = document.getElementById("status-message");
	statusElement.textContent = message;
	statusElement.className = `status-message visible ${type}`;

	setTimeout(() => {
		statusElement.className = "status-message";
	}, 3000);
}
