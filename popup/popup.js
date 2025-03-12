const browserAPI = chrome || browser;

document.addEventListener("DOMContentLoaded", async () => {
	// 国際化対応
	localizeUI();

	// 状態の取得と表示
	await loadPreferences();
	await loadStatistics();

	// イベントリスナーの設定
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

async function loadPreferences() {
	try {
		const result = await browserAPI.storage.local.get({
			isActive: true,
		});

		const toggleActive = document.getElementById("toggle-active");
		toggleActive.checked = result.isActive;

		updateStatusText(result.isActive);
	} catch (error) {
		console.error("設定の読み込み中にエラーが発生しました:", error);
	}
}

async function loadStatistics() {
	try {
		const stats = await browserAPI.storage.local.get({
			totalTimeSaved: 0, // ミリ秒単位
			prefetchedPages: 0, // ページ数
			successfulPrefetches: 0, // 成功数
		});

		const totalTimeFormatted = formatTime(stats.totalTimeSaved);

		// ヒット率の計算
		const hitRate =
			stats.prefetchedPages > 0
				? Math.round(
						(stats.successfulPrefetches / stats.prefetchedPages) *
							100
				  )
				: 0;

		// 統計表示の更新
		document.getElementById("total-time-saved").textContent =
			browserAPI.i18n.getMessage("popupStatsTotalTime", [
				totalTimeFormatted,
			]);

		document.getElementById("prefetched-pages").textContent =
			browserAPI.i18n.getMessage("popupStatsPrefetchedPages", [
				stats.prefetchedPages.toString(),
			]);

		document.getElementById("hit-rate").textContent =
			browserAPI.i18n.getMessage("popupStatsHitRate", [
				hitRate.toString(),
			]);
	} catch (error) {
		console.error("統計データの読み込み中にエラーが発生しました:", error);
	}
}

function formatTime(milliseconds) {
	const seconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;

	if (minutes > 0) {
		return `${minutes}分${remainingSeconds}秒`;
	} else {
		return `${seconds}秒`;
	}
}

function updateStatusText(isActive) {
	const statusText = document.getElementById("status-text");
	const messageId = isActive ? "popupStatusActive" : "popupStatusInactive";
	statusText.textContent = browserAPI.i18n.getMessage(messageId);
}

function setupEventListeners() {
	const toggleActive = document.getElementById("toggle-active");
	toggleActive.addEventListener("change", async (event) => {
		const isActive = event.target.checked;
		updateStatusText(isActive);

		try {
			await browserAPI.storage.local.set({ isActive });
			browserAPI.runtime.sendMessage({
				action: "toggleActive",
				isActive,
			});
		} catch (error) {
			console.error("設定の保存中にエラーが発生しました:", error);
		}
	});

	const openSettings = document.getElementById("open-settings");
	openSettings.addEventListener("click", () => {
		browserAPI.runtime.openOptionsPage();
	});
}
