// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 GilangPambudi

//! Prayer times for the Prayer page: today's and tomorrow's, from Muhammadiyah's KHGT service for the
//! place set in Settings. Asked once a day and kept on disk, so a login asks nothing; nothing runs while
//! the page is off.

use std::sync::Arc;
use std::time::Duration;

use chrono::Local;
use log::warn;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;
use zbus::object_server::InterfaceRef;
use zbus::{fdo, interface};

use crate::clock::{next_midnight, now_ms, wait_until};
use crate::store::Store;

const SCHEDULE: &str = "https://api-khgt.muhammadiyah.or.id/api/sholat/schedule";
const TIMEOUT: Duration = Duration::from_secs(15);
/// After a failed ask (offline, as at login), the next is this much later.
const RETRY_MS: i64 = 10 * 60 * 1000;

/// What the extension sends from Settings.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
struct Config {
    enabled: bool,
    latitude: f64,
    longitude: f64,
}

/// One day's times, "HH:MM" in local time, as the service names them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Day {
    pub date: String,
    pub hijri: String,
    pub imsak: String,
    pub subuh: String,
    pub terbit: String,
    pub dhuha: String,
    pub dzuhur: String,
    pub ashar: String,
    pub maghrib: String,
    pub isya: String,
}

impl Day {
    fn times(&self) -> [&str; 8] {
        [
            &self.imsak,
            &self.subuh,
            &self.terbit,
            &self.dhuha,
            &self.dzuhur,
            &self.ashar,
            &self.maghrib,
            &self.isya,
        ]
    }
}

/// The days asked for, and where: another place asks again.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Cached {
    latitude: f64,
    longitude: f64,
    days: Vec<Day>,
}

/// The Prayer1 D-Bus object: the place from Settings and its times.
pub struct PrayerService {
    config: Config,
    days: Vec<Day>,
    wake: Arc<Notify>,
}

impl PrayerService {
    /// Starts off; the returned `Notify` wakes `run` when Settings change.
    pub fn new() -> (Self, Arc<Notify>) {
        let wake = Arc::new(Notify::new());
        let service = Self {
            config: Config::default(),
            days: Vec::new(),
            wake: wake.clone(),
        };
        (service, wake)
    }
}

#[interface(name = "io.github.zickrian.isle.Prayer1")]
impl PrayerService {
    /// The switch and the place from Settings, as JSON `{enabled, latitude, longitude}`.
    fn set_config(&mut self, config: &str) -> fdo::Result<()> {
        let config: Config = serde_json::from_str(config)
            .map_err(|err| fdo::Error::InvalidArgs(format!("not a prayer config: {err}")))?;
        if !(-90.0..=90.0).contains(&config.latitude)
            || !(-180.0..=180.0).contains(&config.longitude)
        {
            return Err(fdo::Error::InvalidArgs("no such place".into()));
        }
        if config != self.config {
            self.config = config;
            self.wake.notify_one();
        }
        Ok(())
    }

    /// JSON array of today's and tomorrow's [`Day`]s, as far as known; empty while off.
    #[zbus(property)]
    fn schedule(&self) -> String {
        if self.days.is_empty() {
            return String::new();
        }
        serde_json::to_string(&self.days).unwrap_or_default()
    }
}

/// Keeps today's and tomorrow's times while enabled; sleeps otherwise.
pub async fn run(iface: InterfaceRef<PrayerService>, wake: Arc<Notify>) {
    let mut store: Store<Cached> = Store::new("prayer");
    let mut cached = store.load();
    loop {
        let config = iface.get().await.config.clone();
        if !config.enabled {
            publish(&iface, Vec::new()).await;
            wake.notified().await;
            continue;
        }
        if cached.latitude != config.latitude || cached.longitude != config.longitude {
            cached = Cached {
                latitude: config.latitude,
                longitude: config.longitude,
                days: Vec::new(),
            };
        }
        let today = Local::now().date_naive();
        let wanted = [Some(today), today.succ_opt()]
            .into_iter()
            .flatten()
            .map(|date| date.to_string())
            .collect::<Vec<_>>();
        let before = cached.days.len();
        cached.days.retain(|day| wanted.contains(&day.date));
        let mut changed = cached.days.len() != before;
        let mut failed = false;
        for date in &wanted {
            if cached.days.iter().any(|day| &day.date == date) {
                continue;
            }
            let (latitude, longitude, date) = (config.latitude, config.longitude, date.clone());
            match tokio::task::spawn_blocking(move || fetch(latitude, longitude, &date))
                .await
                .ok()
                .flatten()
            {
                Some(day) => {
                    cached.days.push(day);
                    changed = true;
                }
                None => failed = true,
            }
        }
        if changed {
            cached.days.sort_by(|a, b| a.date.cmp(&b.date));
            store.save(&cached);
        }
        publish(&iface, cached.days.clone()).await;
        // A new day, another try, or Settings changed: looked at again either way.
        let deadline = if failed {
            Some(now_ms() + RETRY_MS)
        } else {
            next_midnight()
        };
        wait_until(deadline, &wake).await;
    }
}

/// Sets the `Schedule` property, signalling only when it changed.
async fn publish(iface: &InterfaceRef<PrayerService>, days: Vec<Day>) {
    let mut service = iface.get_mut().await;
    if service.days == days {
        return;
    }
    service.days = days;
    if let Err(err) = service.schedule_changed(iface.signal_emitter()).await {
        warn!("could not publish the prayer times: {err}");
    }
}

/// `date`'s times at the place; `None` if the service could not say.
fn fetch(latitude: f64, longitude: f64, date: &str) -> Option<Day> {
    let reply: Value = crate::http::post(SCHEDULE, TIMEOUT)
        .header("User-Agent", concat!("Isle/", env!("CARGO_PKG_VERSION")))
        .send_json(json!({"lat": latitude, "lng": longitude, "date": date, "mode": "daily"}))
        .and_then(|mut reply| reply.body_mut().read_json())
        .map_err(|err| warn!("could not get the prayer times: {err}"))
        .ok()?;
    parse(&reply, date)
}

/// The day in the service's reply, if it is `date`'s and every time reads as "HH:MM".
fn parse(reply: &Value, date: &str) -> Option<Day> {
    let day: Day = serde_json::from_value(reply["data"]["schedules"].get(0)?.clone()).ok()?;
    let clock = |time: &str| {
        let (hours, minutes) = time.split_once(':').unwrap_or_default();
        hours.len() == 2
            && minutes.len() == 2
            && hours.parse::<u8>().is_ok_and(|h| h < 24)
            && minutes.parse::<u8>().is_ok_and(|m| m < 60)
    };
    (day.date == date && day.times().into_iter().all(clock)).then_some(day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(date: &str, isya: &str) -> Value {
        json!({"success": true, "data": {"timezone": 7, "schedules": [{
            "date": date, "day_name": "Rabu", "hijri": "17 Jumadil Awal 1448 H",
            "imsak": "03:42", "subuh": "03:52", "terbit": "04:59", "dhuha": "05:26",
            "dzuhur": "11:15", "ashar": "14:28", "maghrib": "17:28", "isya": isya,
            "meta": {"tz": 7}
        }]}})
    }

    #[test]
    fn reads_a_day() {
        let day = parse(&reply("2026-10-28", "18:38"), "2026-10-28").unwrap();
        assert_eq!(day.hijri, "17 Jumadil Awal 1448 H");
        assert_eq!(day.subuh, "03:52");
        assert_eq!(day.isya, "18:38");
    }

    #[test]
    fn refuses_another_day_or_odd_times() {
        assert!(parse(&reply("2026-10-27", "18:38"), "2026-10-28").is_none());
        assert!(parse(&reply("2026-10-28", "6:38"), "2026-10-28").is_none());
        assert!(parse(&reply("2026-10-28", "24:00"), "2026-10-28").is_none());
        assert!(parse(&json!({"success": false}), "2026-10-28").is_none());
    }
}
