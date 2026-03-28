# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## glm-5.1
**耗时: 11416ms**

1. 英文版
"In Event-Driven Architecture (EDA), the CQRS pattern separates read and write operations into different models for processing. The Command Side records all state changes through Event Sourcing, while the Query Side maintains a Materialized View to optimize read performance. Eventual Consistency is a core characteristic of this architecture—after a write is confirmed, the read side may experience a delay ranging from a few milliseconds to several seconds before reflecting the latest state. Compensating Transactions are used to handle business rollbacks in distributed scenarios."

2. 日文版
"イベント駆動アーキテクチャ（EDA）では、CQRSパターンは読み取りおよび書き込み操作を別々のモデルに分離して処理します。コマンド側（Command Side）はイベントソーシング（Event Sourcing）を通じてすべての状態変更を記録し、クエリ側（Query Side）は読み取りパフォーマンスを最適化するために実体化ビュー（Materialized View）を維持します。結果整合性（Eventual Consistency）は、このアーキテクチャの中核となる特徴です。書き込みが確認された後、読み取り側が最新の状態を反映するまでに、数ミリ秒から数秒の遅延が発生する可能性があります。補償トランザクション（Compensating Transaction）は、分散シナリオにおけるビジネスのロールバックを処理するために使用されます。"

3. 英文版回译为中文版
"在事件驱动架构（EDA）中，CQRS模式将读写操作分离到不同的模型中进行处理。命令端通过事件溯源记录所有的状态变更，而查询端则维护物化视图以优化读取性能。最终一致性是这种架构的核心特征——在写入操作得到确认后，读取端可能需要经历数毫秒到数秒的延迟，才能反映最新的状态。补偿事务被用于处理分布式场景下的业务回滚。"
