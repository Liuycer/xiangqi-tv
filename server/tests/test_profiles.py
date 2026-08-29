from __future__ import annotations

import tempfile
import unittest
import sqlite3
from pathlib import Path

from app.game_store import (
    AdaptivePolicy,
    GameNotFound,
    GameStore,
    ProfileLimitReached,
    ProfileNotFound,
)


class ProfileStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = GameStore(
            Path(self.temporary_directory.name) / "profiles.db",
            AdaptivePolicy(initial_rating=1050, initial_level=1),
        )
        await self.store.initialize()

    async def asyncTearDown(self) -> None:
        self.temporary_directory.cleanup()

    async def test_bootstrap_migrates_the_legacy_player_without_losing_rating(self) -> None:
        await self.store.get_player_profile("player_legacy")
        profiles = await self.store.bootstrap_profiles("device_12345678", "player_legacy")

        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]["profileId"], "player_legacy")
        self.assertEqual(profiles[0]["deviceId"], "device_12345678")
        self.assertEqual(profiles[0]["rating"], 1050)
        self.assertEqual(profiles[0]["currentCode"], "A1")

    async def test_schema_v4_timestamp_column_migrates_on_older_sqlite(self) -> None:
        database_path = Path(self.temporary_directory.name) / "legacy.db"
        with sqlite3.connect(database_path) as connection:
            connection.executescript(
                """
                CREATE TABLE players (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    rating REAL NOT NULL DEFAULT 1200,
                    recommended_level INTEGER NOT NULL DEFAULT 2,
                    rated_games INTEGER NOT NULL DEFAULT 0,
                    current_level INTEGER NOT NULL DEFAULT 2,
                    games_since_adjustment INTEGER NOT NULL DEFAULT 0,
                    locked_level INTEGER
                );
                INSERT INTO players(id) VALUES ('player_old_schema');
                """
            )
        store = GameStore(database_path)

        await store.initialize()
        profiles = await store.bootstrap_profiles("device_12345678", "player_old_schema")

        self.assertEqual(profiles[0]["profileId"], "player_old_schema")
        self.assertTrue(profiles[0]["lastActiveAt"])

    async def test_profiles_are_isolated_by_device_and_soft_archived(self) -> None:
        first = (await self.store.bootstrap_profiles("device_12345678", None))[0]
        second = await self.store.create_profile(
            "device_12345678", "小明", "horse"
        )
        await self.store.bootstrap_profiles("device_87654321", None)

        with self.assertRaises(ProfileNotFound):
            await self.store.assert_profile_owner(
                "device_87654321", second["profileId"]
            )

        await self.store.archive_profile("device_12345678", second["profileId"])
        profiles = await self.store.list_profiles("device_12345678")
        self.assertEqual([profile["profileId"] for profile in profiles], [first["profileId"]])

        with self.assertRaises(ProfileLimitReached):
            await self.store.archive_profile("device_12345678", first["profileId"])

    async def test_new_profiles_start_at_a1_and_can_be_reset(self) -> None:
        await self.store.bootstrap_profiles("device_12345678", None)
        created = await self.store.create_profile(
            "device_12345678", "新棋手", "cannon"
        )

        self.assertEqual(created["rating"], 1050)
        self.assertEqual(created["currentLevel"], 1)
        self.assertEqual(created["currentDepth"], 3)

        reset = await self.store.reset_player_rating(created["profileId"])
        self.assertEqual(reset["rating"], 1050)
        self.assertEqual(reset["currentLevel"], 1)

    async def test_one_time_recovery_code_transfers_complete_profile(self) -> None:
        profile = (await self.store.bootstrap_profiles("device_12345678", None))[0]
        generated = await self.store.generate_profile_recovery_code(
            "device_12345678",
            profile["profileId"],
        )

        self.assertRegex(
            generated["recoveryCode"],
            r"^XQ-[23456789A-HJ-NP-Z]{4}(?:-[23456789A-HJ-NP-Z]{4}){3}$",
        )
        recovered = await self.store.recover_profile(
            "device_87654321",
            generated["recoveryCode"].lower().replace("-", " "),
        )

        self.assertEqual(recovered["profileId"], profile["profileId"])
        self.assertEqual(recovered["deviceId"], "device_87654321")
        self.assertEqual(recovered["rating"], profile["rating"])
        with self.assertRaises(ProfileNotFound):
            await self.store.assert_profile_owner(
                "device_12345678",
                profile["profileId"],
            )
        with self.assertRaises(ProfileNotFound):
            await self.store.recover_profile(
                "device_third_1234",
                generated["recoveryCode"],
            )

    async def test_generating_a_new_recovery_code_invalidates_the_old_one(self) -> None:
        profile = (await self.store.bootstrap_profiles("device_12345678", None))[0]
        first = await self.store.generate_profile_recovery_code(
            "device_12345678", profile["profileId"]
        )
        second = await self.store.generate_profile_recovery_code(
            "device_12345678", profile["profileId"]
        )

        self.assertNotEqual(first["recoveryCode"], second["recoveryCode"])
        with self.assertRaises(ProfileNotFound):
            await self.store.recover_profile("device_87654321", first["recoveryCode"])
        recovered = await self.store.recover_profile(
            "device_87654321", second["recoveryCode"]
        )
        self.assertEqual(recovered["profileId"], profile["profileId"])

    async def test_recovery_respects_target_device_profile_limit(self) -> None:
        source = (await self.store.bootstrap_profiles("device_source_123", None))[0]
        generated = await self.store.generate_profile_recovery_code(
            "device_source_123", source["profileId"]
        )
        await self.store.bootstrap_profiles("device_target_123", None)
        for index in range(5):
            await self.store.create_profile(
                "device_target_123", f"棋手{index}", "horse"
            )

        with self.assertRaises(ProfileLimitReached):
            await self.store.recover_profile(
                "device_target_123", generated["recoveryCode"]
            )
        await self.store.assert_profile_owner(
            "device_source_123", source["profileId"]
        )

    async def test_archiving_a_profile_invalidates_its_recovery_code(self) -> None:
        profiles = await self.store.bootstrap_profiles("device_12345678", None)
        archived = await self.store.create_profile(
            "device_12345678", "待删除", "advisor"
        )
        generated = await self.store.generate_profile_recovery_code(
            "device_12345678", archived["profileId"]
        )

        await self.store.archive_profile("device_12345678", archived["profileId"])

        self.assertEqual(len(profiles), 1)
        with self.assertRaises(ProfileNotFound):
            await self.store.recover_profile(
                "device_87654321", generated["recoveryCode"]
            )

    async def test_game_ownership_requires_the_matching_device_and_profile(self) -> None:
        profile = (await self.store.bootstrap_profiles("device_12345678", None))[0]
        game = await self.store.create_game(
            client_game_id="game_12345678",
            player_id=profile["profileId"],
            mode="ai",
            difficulty="adaptive",
            ai_depth=3,
            variation_seed=7,
            adaptive_level=1,
            initial_fen="initial",
        )

        await self.store.assert_game_owner(
            "device_12345678", profile["profileId"], game["id"]
        )
        with self.assertRaises(GameNotFound):
            await self.store.assert_game_owner(
                "device_87654321", profile["profileId"], game["id"]
            )

    async def test_untouched_games_are_hidden_and_discarded_when_abandoned(self) -> None:
        profile = (await self.store.bootstrap_profiles("device_12345678", None))[0]
        game = await self.store.create_game(
            client_game_id="game_empty_12345678",
            player_id=profile["profileId"],
            mode="ai",
            difficulty="adaptive",
            ai_depth=3,
            variation_seed=7,
            adaptive_level=1,
            initial_fen="initial",
        )

        history = await self.store.list_games(profile["profileId"], limit=20, offset=0)
        self.assertEqual(history["total"], 0)
        self.assertEqual(history["items"], [])

        discarded = await self.store.finish_game(
            game["id"],
            state="abandoned",
            result="abandoned",
            termination="restart",
            moves=[],
            current_player="red",
            undo_count=0,
            fallback_used=False,
            settings_changed=False,
        )
        self.assertIsNone(discarded)
        with self.assertRaises(GameNotFound):
            await self.store.get_game_detail(game["id"], profile["profileId"])

    async def test_new_game_replaces_an_untouched_active_game_without_history(self) -> None:
        profile = (await self.store.bootstrap_profiles("device_12345678", None))[0]
        empty = await self.store.create_game(
            client_game_id="game_empty_old_12345678",
            player_id=profile["profileId"],
            mode="ai",
            difficulty="adaptive",
            ai_depth=3,
            variation_seed=7,
            adaptive_level=1,
            initial_fen="initial",
        )
        await self.store.create_game(
            client_game_id="game_empty_new_12345678",
            player_id=profile["profileId"],
            mode="ai",
            difficulty="adaptive",
            ai_depth=3,
            variation_seed=8,
            adaptive_level=1,
            initial_fen="initial",
        )

        with self.assertRaises(GameNotFound):
            await self.store.get_game_detail(empty["id"], profile["profileId"])

    async def test_abandoned_game_with_moves_remains_in_history(self) -> None:
        profile = (await self.store.bootstrap_profiles("device_12345678", None))[0]
        game = await self.store.create_game(
            client_game_id="game_played_12345678",
            player_id=profile["profileId"],
            mode="ai",
            difficulty="adaptive",
            ai_depth=3,
            variation_seed=7,
            adaptive_level=1,
            initial_fen="initial",
        )
        stored = await self.store.finish_game(
            game["id"],
            state="abandoned",
            result="abandoned",
            termination="restart",
            moves=["a0a1"],
            current_player="black",
            undo_count=0,
            fallback_used=False,
            settings_changed=False,
        )

        self.assertIsNotNone(stored)
        history = await self.store.list_games(profile["profileId"], limit=20, offset=0)
        self.assertEqual(history["total"], 1)
        self.assertEqual(history["items"][0]["plyCount"], 1)


if __name__ == "__main__":
    unittest.main()
